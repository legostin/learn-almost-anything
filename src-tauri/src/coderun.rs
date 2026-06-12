// Local execution of lesson code snippets (the "code" template widget).
// Code runs with the user's privileges in a throwaway temp dir — the same
// trust level as the user pasting the snippet into a terminal. These commands
// are deliberately NOT exposed in share.rs dispatch, so the remote web UI can
// never trigger execution.
use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use uuid::Uuid;

use crate::sidecar;

const PY_TRACER: &str = include_str!("py_tracer.py");
const OUTPUT_CAP: usize = 64 * 1024;
const TRACE_OUTPUT_CAP: usize = 512 * 1024;
const MAX_CODE_LEN: usize = 64 * 1024;
const COMPILE_TIMEOUT: Duration = Duration::from_secs(30);
const RUN_TIMEOUT: Duration = Duration::from_secs(10);
// `java Main.java` compiles inside the launcher, so it gets the compile budget.
const JAVA_RUN_TIMEOUT: Duration = Duration::from_secs(30);
const RUNTIME_CACHE_TTL: Duration = Duration::from_secs(300);

pub struct LangSpec {
    pub id: &'static str,
    pub label: &'static str,
    pub file_name: &'static str,
    /// Binary candidates; the first one found on the expanded PATH wins.
    pub binaries: &'static [&'static str],
    pub version_args: &'static [&'static str],
}

pub const LANGS: &[LangSpec] = &[
    LangSpec {
        id: "python",
        label: "Python",
        file_name: "main.py",
        binaries: &["python3"],
        version_args: &["--version"],
    },
    LangSpec {
        id: "javascript",
        label: "JavaScript",
        file_name: "main.js",
        binaries: &["node"],
        version_args: &["--version"],
    },
    LangSpec {
        id: "go",
        label: "Go",
        file_name: "main.go",
        binaries: &["go"],
        version_args: &["version"],
    },
    LangSpec {
        id: "c",
        label: "C",
        file_name: "main.c",
        binaries: &["cc", "gcc"],
        version_args: &["--version"],
    },
    LangSpec {
        id: "cpp",
        label: "C++",
        file_name: "main.cpp",
        binaries: &["c++", "g++"],
        version_args: &["--version"],
    },
    LangSpec {
        id: "rust",
        label: "Rust",
        file_name: "main.rs",
        binaries: &["rustc"],
        version_args: &["--version"],
    },
    LangSpec {
        id: "java",
        label: "Java",
        file_name: "Main.java",
        binaries: &["java"],
        version_args: &["-version"],
    },
];

fn lang_spec(id: &str) -> Option<&'static LangSpec> {
    LANGS.iter().find(|l| l.id == id)
}

fn install_hint(id: &str) -> (&'static str, &'static str) {
    // (command/instruction, url)
    if cfg!(target_os = "macos") {
        match id {
            "python" => ("brew install python3", "https://www.python.org/downloads/"),
            "javascript" => ("brew install node", "https://nodejs.org/"),
            "go" => ("brew install go", "https://go.dev/dl/"),
            "c" | "cpp" => ("xcode-select --install", "https://developer.apple.com/xcode/resources/"),
            "rust" => ("brew install rust", "https://rustup.rs/"),
            "java" => ("brew install openjdk", "https://adoptium.net/"),
            _ => ("", ""),
        }
    } else if cfg!(target_os = "windows") {
        match id {
            "python" => ("winget install Python.Python.3.12", "https://www.python.org/downloads/"),
            "javascript" => ("winget install OpenJS.NodeJS.LTS", "https://nodejs.org/"),
            "go" => ("winget install GoLang.Go", "https://go.dev/dl/"),
            "c" | "cpp" => (
                "Install MinGW-w64 or Visual Studio Build Tools",
                "https://visualstudio.microsoft.com/visual-cpp-build-tools/",
            ),
            "rust" => ("winget install Rustlang.Rustup", "https://rustup.rs/"),
            "java" => ("winget install Microsoft.OpenJDK.21", "https://adoptium.net/"),
            _ => ("", ""),
        }
    } else {
        match id {
            "python" => ("sudo apt install python3", "https://www.python.org/downloads/"),
            "javascript" => ("sudo apt install nodejs", "https://nodejs.org/"),
            "go" => ("sudo apt install golang", "https://go.dev/dl/"),
            "c" | "cpp" => ("sudo apt install build-essential", "https://gcc.gnu.org/"),
            "rust" => ("sudo apt install rustc", "https://rustup.rs/"),
            "java" => ("sudo apt install default-jdk", "https://adoptium.net/"),
            _ => ("", ""),
        }
    }
}

fn exe_path(dir: &Path) -> PathBuf {
    dir.join(if cfg!(windows) { "main.exe" } else { "main" })
}

/// (compile argv, run argv) for the language; argv[0] is the program.
fn plan_commands(
    spec: &LangSpec,
    bin: &Path,
    dir: &Path,
) -> (Option<Vec<OsString>>, Vec<OsString>) {
    let b: OsString = bin.into();
    let exe: OsString = exe_path(dir).into();
    let os = |s: &str| OsString::from(s);
    match spec.id {
        "python" => (None, vec![b, os("main.py")]),
        "javascript" => (None, vec![b, os("main.js")]),
        "go" => (
            Some(vec![b, os("build"), os("-o"), exe.clone(), os("main.go")]),
            vec![exe],
        ),
        "c" => (
            Some(vec![b, os("main.c"), os("-std=c11"), os("-o"), exe.clone()]),
            vec![exe],
        ),
        "cpp" => (
            Some(vec![b, os("main.cpp"), os("-std=c++17"), os("-o"), exe.clone()]),
            vec![exe],
        ),
        "rust" => (
            Some(vec![b, os("--edition=2021"), os("main.rs"), os("-o"), exe.clone()]),
            vec![exe],
        ),
        "java" => (None, vec![b, os("Main.java")]),
        _ => (None, vec![b]),
    }
}

fn build_command(argv: &[OsString], dir: &Path) -> Command {
    let mut cmd = Command::new(&argv[0]);
    cmd.args(&argv[1..])
        .current_dir(dir)
        .env("PATH", sidecar::expanded_path());
    if argv[0].to_string_lossy().contains("python") {
        cmd.env("PYTHONIOENCODING", "utf-8");
    }
    cmd
}

pub struct ExecOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub truncated: bool,
    pub duration_ms: u64,
}

fn cap_reader(
    stream: impl Read + Send + 'static,
    cap: usize,
) -> std::thread::JoinHandle<(Vec<u8>, bool)> {
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let mut truncated = false;
        let mut chunk = [0u8; 8192];
        let mut r = stream;
        loop {
            match r.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if buf.len() < cap {
                        let take = n.min(cap - buf.len());
                        buf.extend_from_slice(&chunk[..take]);
                        if take < n {
                            truncated = true;
                        }
                    } else {
                        // Keep draining so the child never blocks on a full pipe.
                        truncated = true;
                    }
                }
            }
        }
        (buf, truncated)
    })
}

fn run_with_timeout(
    mut cmd: Command,
    stdin_data: Option<&str>,
    timeout: Duration,
    cap: usize,
) -> Result<ExecOutput, String> {
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let started = Instant::now();
    let mut child = cmd.spawn().map_err(|e| format!("spawn failed: {e}"))?;
    if let Some(mut si) = child.stdin.take() {
        if let Some(data) = stdin_data {
            let _ = si.write_all(data.as_bytes());
        }
        // Drop closes the pipe -> EOF; e.g. python input() past data raises EOFError.
    }
    let out_t = cap_reader(child.stdout.take().expect("piped stdout"), cap);
    let err_t = cap_reader(child.stderr.take().expect("piped stderr"), cap);
    let mut timed_out = false;
    let status = loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(st) => break Some(st),
            None if started.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                timed_out = true;
                break None;
            }
            None => std::thread::sleep(Duration::from_millis(50)),
        }
    };
    let (so, so_trunc) = out_t.join().unwrap_or_default();
    let (se, se_trunc) = err_t.join().unwrap_or_default();
    Ok(ExecOutput {
        stdout: String::from_utf8_lossy(&so).into_owned(),
        stderr: String::from_utf8_lossy(&se).into_owned(),
        exit_code: status.and_then(|s| s.code()),
        timed_out,
        truncated: so_trunc || se_trunc,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

/// Temp work dir removed on drop, so cleanup survives early returns.
struct TempDir(PathBuf);

impl TempDir {
    fn create() -> Result<Self, String> {
        let dir = std::env::temp_dir().join(format!("laa-run-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).map_err(|e| format!("temp dir: {e}"))?;
        Ok(Self(dir))
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[derive(serde::Serialize, Clone)]
pub struct RuntimeStatus {
    pub language: String,
    pub label: String,
    pub available: bool,
    pub version: Option<String>,
    pub install_hint: String,
    pub url: String,
}

static RUNTIME_CACHE: Mutex<Option<(Instant, Vec<RuntimeStatus>)>> = Mutex::new(None);

fn parse_java_major(version_line: &str) -> Option<u32> {
    // e.g. `openjdk version "21.0.2"` or `java version "1.8.0_392"`.
    let quoted = version_line.split('"').nth(1)?;
    let mut parts = quoted.split('.');
    let first: u32 = parts.next()?.parse().ok()?;
    if first == 1 {
        parts.next()?.parse().ok()
    } else {
        Some(first)
    }
}

fn probe_runtimes() -> Vec<RuntimeStatus> {
    LANGS
        .iter()
        .map(|spec| {
            let (hint, url) = install_hint(spec.id);
            let bin = spec
                .binaries
                .iter()
                .find_map(|b| sidecar::command_path_if_found(b));
            let (mut available, mut version) = (false, None);
            if let Some(bin) = bin {
                let mut cmd = Command::new(&bin);
                cmd.args(spec.version_args).env("PATH", sidecar::expanded_path());
                if let Ok(out) =
                    run_with_timeout(cmd, None, Duration::from_secs(3), OUTPUT_CAP)
                {
                    // java -version prints to stderr.
                    let text = if out.stdout.trim().is_empty() { out.stderr } else { out.stdout };
                    let line = text.lines().next().unwrap_or("").trim().to_string();
                    if !line.is_empty() && out.exit_code == Some(0) {
                        available = true;
                        version = Some(line.clone());
                        if spec.id == "java" {
                            // The single-file source launcher needs JDK >= 11.
                            if parse_java_major(&line).is_none_or(|m| m < 11) {
                                available = false;
                            }
                        }
                    }
                }
            }
            RuntimeStatus {
                language: spec.id.to_string(),
                label: spec.label.to_string(),
                available,
                version,
                install_hint: hint.to_string(),
                url: url.to_string(),
            }
        })
        .collect()
}

#[tauri::command]
pub async fn check_code_runtimes(refresh: Option<bool>) -> Result<Vec<RuntimeStatus>, String> {
    let refresh = refresh.unwrap_or(false);
    if !refresh {
        if let Ok(guard) = RUNTIME_CACHE.lock() {
            if let Some((at, cached)) = guard.as_ref() {
                if at.elapsed() < RUNTIME_CACHE_TTL {
                    return Ok(cached.clone());
                }
            }
        }
    }
    let statuses = tauri::async_runtime::spawn_blocking(probe_runtimes)
        .await
        .map_err(|e| e.to_string())?;
    if let Ok(mut guard) = RUNTIME_CACHE.lock() {
        *guard = Some((Instant::now(), statuses.clone()));
    }
    Ok(statuses)
}

#[derive(serde::Serialize)]
pub struct RunResult {
    pub phase: String, // "compile" | "run"
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub truncated: bool,
    pub duration_ms: u64,
}

impl RunResult {
    fn from_exec(phase: &str, out: ExecOutput) -> Self {
        Self {
            phase: phase.to_string(),
            stdout: out.stdout,
            stderr: out.stderr,
            exit_code: out.exit_code,
            timed_out: out.timed_out,
            truncated: out.truncated,
            duration_ms: out.duration_ms,
        }
    }
}

/// Synchronous core shared by the run_code_snippet command and the assignment
/// autograder: write, compile (if the language needs it), run with stdin.
pub fn run_code_blocking(
    language: &str,
    code: &str,
    stdin: Option<&str>,
) -> Result<RunResult, String> {
    let spec = lang_spec(language).ok_or_else(|| format!("unknown language: {language}"))?;
    if code.len() > MAX_CODE_LEN {
        return Err("code too large".to_string());
    }
    let bin = spec
        .binaries
        .iter()
        .find_map(|b| sidecar::command_path_if_found(b))
        .ok_or_else(|| {
            let (hint, _) = install_hint(spec.id);
            format!("{} is not installed ({hint})", spec.label)
        })?;
    let dir = TempDir::create()?;
    std::fs::write(dir.0.join(spec.file_name), code).map_err(|e| e.to_string())?;
    let (compile_argv, run_argv) = plan_commands(spec, &bin, &dir.0);
    if let Some(argv) = compile_argv {
        let out = run_with_timeout(
            build_command(&argv, &dir.0),
            None,
            COMPILE_TIMEOUT,
            OUTPUT_CAP,
        )?;
        if out.timed_out || out.exit_code != Some(0) {
            return Ok(RunResult::from_exec("compile", out));
        }
    }
    let timeout = if spec.id == "java" { JAVA_RUN_TIMEOUT } else { RUN_TIMEOUT };
    let out = run_with_timeout(
        build_command(&run_argv, &dir.0),
        stdin,
        timeout,
        OUTPUT_CAP,
    )?;
    Ok(RunResult::from_exec("run", out))
}

/// Source file name for a language ("main.py", "Main.java", ...).
pub fn source_file_name(language: &str) -> Option<&'static str> {
    lang_spec(language).map(|s| s.file_name)
}

/// Output comparison must never fail on CRLF or trailing whitespace (mirrors
/// normalizeRunOutput on the frontend).
pub fn normalize_run_output(s: &str) -> String {
    s.replace("\r\n", "\n")
        .split('\n')
        .map(|l| l.trim_end())
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

#[tauri::command]
pub async fn run_code_snippet(
    language: String,
    code: String,
    stdin: Option<String>,
) -> Result<RunResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_code_blocking(&language, &code, stdin.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn trace_python_snippet(code: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if code.len() > MAX_CODE_LEN {
            return Err("code too large".to_string());
        }
        let bin = sidecar::command_path_if_found("python3").ok_or_else(|| {
            let (hint, _) = install_hint("python");
            format!("Python is not installed ({hint})")
        })?;
        let dir = TempDir::create()?;
        std::fs::write(dir.0.join("main.py"), &code).map_err(|e| e.to_string())?;
        std::fs::write(dir.0.join("laa_tracer.py"), PY_TRACER).map_err(|e| e.to_string())?;
        let argv: Vec<OsString> = vec![
            bin.into(),
            OsString::from("laa_tracer.py"),
            OsString::from("main.py"),
        ];
        let out = run_with_timeout(
            build_command(&argv, &dir.0),
            None,
            RUN_TIMEOUT,
            TRACE_OUTPUT_CAP,
        )?;
        if out.timed_out {
            return Err("trace timed out".to_string());
        }
        serde_json::from_str(&out.stdout).map_err(|_| {
            let err = out.stderr.trim();
            let snippet: String = err.chars().take(500).collect();
            if snippet.is_empty() {
                "trace produced no output".to_string()
            } else {
                snippet
            }
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

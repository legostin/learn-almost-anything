use std::collections::HashMap;
use std::env;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, thiserror::Error)]
pub enum SidecarError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error("sidecar returned error: {0}")]
    Remote(String),
    #[error("sidecar response timed out")]
    Timeout,
    #[error("sidecar exited before responding")]
    Dropped,
}

#[derive(Serialize)]
struct Request<'a> {
    id: String,
    method: &'a str,
    params: Value,
}

#[derive(Deserialize)]
struct Envelope {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    progress: Option<ProgressPayload>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct ProgressPayload {
    pub id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub detail: Option<String>,
}

pub enum SidecarMsg {
    Progress(ProgressPayload),
    Done(Result<Value, String>),
}

#[cfg(target_os = "macos")]
const EXTRA_PATH_DIRS: &[&str] = &[
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
];

#[cfg(all(unix, not(target_os = "macos")))]
const EXTRA_PATH_DIRS: &[&str] = &["/usr/local/bin", "/usr/bin", "/bin"];

#[cfg(windows)]
const EXTRA_PATH_DIRS: &[&str] = &[];

#[cfg(target_os = "macos")]
const EXTRA_HOME_PATH_DIRS: &[&str] = &[
    ".npm-global/bin",
    ".local/bin",
    ".cargo/bin",
    ".bun/bin",
    ".volta/bin",
    "Library/pnpm",
];

#[cfg(all(unix, not(target_os = "macos")))]
const EXTRA_HOME_PATH_DIRS: &[&str] = &[
    ".npm-global/bin",
    ".local/bin",
    ".cargo/bin",
    ".bun/bin",
    ".volta/bin",
];

#[cfg(windows)]
const EXTRA_HOME_PATH_DIRS: &[&str] = &[".cargo\\bin", ".bun\\bin", ".volta\\bin"];

static SHELL_PATH_DIRS: OnceLock<Vec<PathBuf>> = OnceLock::new();

type Pending = Arc<Mutex<HashMap<String, mpsc::Sender<SidecarMsg>>>>;

pub struct Sidecar {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    pending: Pending,
    next_id: AtomicU64,
}

pub fn expanded_path() -> OsString {
    let mut paths: Vec<PathBuf> = env::var_os("PATH")
        .map(|p| env::split_paths(&p).collect())
        .unwrap_or_default();

    for dir in EXTRA_PATH_DIRS {
        push_unique_path(&mut paths, PathBuf::from(dir));
    }

    push_home_path_dirs(&mut paths);
    push_env_path_dirs(&mut paths);
    for dir in shell_path_dirs() {
        push_unique_path(&mut paths, dir.clone());
    }

    env::join_paths(paths).unwrap_or_else(|_| OsString::from(env::var("PATH").unwrap_or_default()))
}

pub fn command_path(name: &str) -> PathBuf {
    let path = expanded_path();
    if let Some(candidate) = find_executable_in_path(name, &path) {
        return candidate;
    }
    if let Some(candidate) = shell_command_path(name) {
        return candidate;
    }
    PathBuf::from(name)
}

fn command_path_if_found(name: &str) -> Option<PathBuf> {
    let path = command_path(name);
    path.is_absolute().then_some(path)
}

fn push_unique_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if !paths.iter().any(|p| p == &path) {
        paths.push(path);
    }
}

#[cfg(unix)]
fn push_home_path_dirs(paths: &mut Vec<PathBuf>) {
    let Some(home) = env::var_os("HOME") else {
        return;
    };
    let home = PathBuf::from(home);
    for dir in EXTRA_HOME_PATH_DIRS {
        push_unique_path(paths, home.join(dir));
    }
}

#[cfg(windows)]
fn push_home_path_dirs(paths: &mut Vec<PathBuf>) {
    let Some(home) = env::var_os("USERPROFILE") else {
        return;
    };
    let home = PathBuf::from(home);
    for dir in EXTRA_HOME_PATH_DIRS {
        push_unique_path(paths, home.join(dir));
    }
}

#[cfg(windows)]
fn push_env_path_dirs(paths: &mut Vec<PathBuf>) {
    for (var, suffix) in [
        ("APPDATA", Some("npm")),
        ("LOCALAPPDATA", Some("pnpm")),
        ("LOCALAPPDATA", Some("Volta\\bin")),
    ] {
        let Some(base) = env::var_os(var) else {
            continue;
        };
        let mut path = PathBuf::from(base);
        if let Some(suffix) = suffix {
            path.push(suffix);
        }
        push_unique_path(paths, path);
    }
}

#[cfg(not(windows))]
fn push_env_path_dirs(_paths: &mut Vec<PathBuf>) {}

fn find_executable_in_path(name: &str, path: &OsString) -> Option<PathBuf> {
    for dir in env::split_paths(path) {
        for candidate in executable_candidates(&dir, name) {
            if executable_exists(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

#[cfg(windows)]
fn executable_candidates(dir: &Path, name: &str) -> Vec<PathBuf> {
    let raw = dir.join(name);
    if Path::new(name).extension().is_some() {
        return vec![raw];
    }

    let mut candidates = vec![raw];
    let pathext = env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
    for ext in pathext.split(';').filter(|ext| !ext.is_empty()) {
        candidates.push(dir.join(format!("{name}{ext}")));
    }
    candidates
}

#[cfg(not(windows))]
fn executable_candidates(dir: &Path, name: &str) -> Vec<PathBuf> {
    vec![dir.join(name)]
}

fn shell_path_dirs() -> &'static [PathBuf] {
    SHELL_PATH_DIRS.get_or_init(load_shell_path_dirs).as_slice()
}

#[cfg(unix)]
fn load_shell_path_dirs() -> Vec<PathBuf> {
    let Some(output) = login_shell_output("printf '\\n__LEARN_ANYTHING_PATH__%s\\n' \"$PATH\"")
    else {
        return Vec::new();
    };
    let Some(path) = marker_value(&output, "__LEARN_ANYTHING_PATH__") else {
        return Vec::new();
    };
    env::split_paths(&OsString::from(path)).collect()
}

#[cfg(windows)]
fn load_shell_path_dirs() -> Vec<PathBuf> {
    Vec::new()
}

#[cfg(unix)]
fn shell_command_path(name: &str) -> Option<PathBuf> {
    let output = login_shell_output(&format!(
        "printf '\\n__LEARN_ANYTHING_CMD__%s\\n' \"$(command -v {} 2>/dev/null)\"",
        shell_quote(name)
    ))?;
    marker_value(&output, "__LEARN_ANYTHING_CMD__")
        .into_iter()
        .map(str::trim)
        .find_map(|line| {
            let path = PathBuf::from(line);
            (path.is_absolute() && executable_exists(&path)).then_some(path)
        })
}

#[cfg(windows)]
fn shell_command_path(name: &str) -> Option<PathBuf> {
    let mut command = Command::new("where.exe");
    command.arg(name).env("PATH", expanded_path());
    let output = command_output_with_timeout(command, Duration::from_secs(2))?;
    output.lines().map(str::trim).find_map(|line| {
        let path = PathBuf::from(line);
        (path.is_absolute() && executable_exists(&path)).then_some(path)
    })
}

#[cfg(unix)]
fn login_shell_output(script: &str) -> Option<String> {
    let shell = env::var_os("SHELL")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute() && executable_exists(p))
        .unwrap_or_else(default_shell);
    let mut command = Command::new(shell);
    let login_arg = if command.get_program().to_string_lossy().ends_with("/sh") {
        "-c"
    } else {
        "-lic"
    };
    command.arg(login_arg).arg(script);
    command_output_with_timeout(command, Duration::from_secs(2))
}

#[cfg(unix)]
fn default_shell() -> PathBuf {
    if cfg!(target_os = "macos") {
        PathBuf::from("/bin/zsh")
    } else {
        PathBuf::from("/bin/sh")
    }
}

#[cfg(unix)]
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(unix)]
fn marker_value<'a>(output: &'a str, marker: &str) -> Option<&'a str> {
    output
        .lines()
        .rev()
        .find_map(|line| line.strip_prefix(marker))
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn command_output_with_timeout(mut command: Command, timeout: Duration) -> Option<String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = command.spawn().ok()?;
    let start = Instant::now();

    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                let output = child.wait_with_output().ok()?;
                return output
                    .status
                    .success()
                    .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string());
            }
            Ok(None) => {}
            Err(_) => return None,
        }
        if start.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(unix)]
fn executable_exists(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;

    path.metadata()
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn executable_exists(path: &Path) -> bool {
    path.is_file()
}

impl Sidecar {
    pub fn spawn(script: &Path) -> Result<Self, SidecarError> {
        let expanded_path = expanded_path();
        let mut command = Command::new(command_path("node"));
        command
            .arg(script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .env("PATH", &expanded_path)
            .env_remove("ANTHROPIC_API_KEY");

        if let Some(path) = command_path_if_found("claude") {
            command.env("LEARN_ANYTHING_CLAUDE_CLI", path);
        }
        if let Some(path) = command_path_if_found("codex") {
            command.env("LEARN_ANYTHING_CODEX_CLI", path);
        }

        let mut child = command.spawn()?;

        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");

        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let pending_reader = pending.clone();

        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }
                match serde_json::from_str::<Envelope>(&line) {
                    Ok(env) => {
                        if let Some(progress) = env.progress {
                            let pid = progress.id.clone();
                            // Don't remove the entry — more messages will come.
                            if let Some(tx) = pending_reader.lock().unwrap().get(&pid) {
                                let _ = tx.send(SidecarMsg::Progress(progress));
                            }
                            continue;
                        }
                        let Some(id) = env.id else { continue };
                        let tx = pending_reader.lock().unwrap().remove(&id);
                        if let Some(tx) = tx {
                            let payload = match env.error {
                                Some(e) => Err(e),
                                None => Ok(env.result.unwrap_or(Value::Null)),
                            };
                            let _ = tx.send(SidecarMsg::Done(payload));
                        }
                    }
                    Err(e) => eprintln!("[sidecar-reader] bad line: {e}: {line}"),
                }
            }
            eprintln!("[sidecar-reader] stdout closed");
        });

        Ok(Self {
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            pending,
            next_id: AtomicU64::new(1),
        })
    }

    pub fn call(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, SidecarError> {
        self.call_with_progress(method, params, timeout, |_| {})
    }

    pub fn call_with_progress<F>(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
        on_progress: F,
    ) -> Result<Value, SidecarError>
    where
        F: Fn(ProgressPayload),
    {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed).to_string();
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap().insert(id.clone(), tx);

        let req = Request {
            id: id.clone(),
            method,
            params,
        };
        let line = serde_json::to_string(&req)?;
        {
            let mut stdin = self.stdin.lock().unwrap();
            stdin.write_all(line.as_bytes())?;
            stdin.write_all(b"\n")?;
            stdin.flush()?;
        }

        let deadline = Instant::now() + timeout;
        loop {
            let now = Instant::now();
            if now >= deadline {
                self.pending.lock().unwrap().remove(&id);
                return Err(SidecarError::Timeout);
            }
            match rx.recv_timeout(deadline - now) {
                Ok(SidecarMsg::Progress(p)) => on_progress(p),
                Ok(SidecarMsg::Done(Ok(v))) => return Ok(v),
                Ok(SidecarMsg::Done(Err(e))) => return Err(SidecarError::Remote(e)),
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    self.pending.lock().unwrap().remove(&id);
                    return Err(SidecarError::Timeout);
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    self.pending.lock().unwrap().remove(&id);
                    return Err(SidecarError::Dropped);
                }
            }
        }
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

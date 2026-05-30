use std::collections::HashMap;
use std::env;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
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

#[cfg(not(target_os = "macos"))]
const EXTRA_PATH_DIRS: &[&str] = &[];

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

    env::join_paths(paths).unwrap_or_else(|_| OsString::from(env::var("PATH").unwrap_or_default()))
}

pub fn command_path(name: &str) -> PathBuf {
    let path = expanded_path();
    for dir in env::split_paths(&path) {
        let candidate = dir.join(name);
        if executable_exists(&candidate) {
            return candidate;
        }
    }
    PathBuf::from(name)
}

fn push_unique_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if !paths.iter().any(|p| p == &path) {
        paths.push(path);
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
        let mut child = Command::new(command_path("node"))
            .arg(script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .env("PATH", expanded_path())
            .env_remove("ANTHROPIC_API_KEY")
            .spawn()?;

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

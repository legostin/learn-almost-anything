use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

#[derive(Debug, Default, Clone, Deserialize, Serialize)]
pub struct Settings {
    #[serde(default)]
    pub brave_api_key: Option<String>,
}

pub struct SettingsState {
    pub data_dir: PathBuf,
    pub inner: Mutex<Settings>,
}

impl SettingsState {
    pub fn load(data_dir: PathBuf) -> Self {
        let path = settings_path(&data_dir);
        let inner = fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Self {
            data_dir,
            inner: Mutex::new(inner),
        }
    }

    pub fn brave_api_key(&self) -> Option<String> {
        self.inner
            .lock()
            .ok()
            .and_then(|s| s.brave_api_key.clone())
            .filter(|k| !k.trim().is_empty())
    }

    pub fn set_brave_api_key(&self, key: Option<String>) -> std::io::Result<()> {
        {
            let mut guard = self.inner.lock().expect("settings lock");
            guard.brave_api_key = key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty());
        }
        self.persist()
    }

    fn persist(&self) -> std::io::Result<()> {
        let snapshot = self.inner.lock().expect("settings lock").clone();
        let path = settings_path(&self.data_dir);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(&snapshot)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
        fs::write(path, json)
    }
}

fn settings_path(data_dir: &PathBuf) -> PathBuf {
    data_dir.join("settings.json")
}

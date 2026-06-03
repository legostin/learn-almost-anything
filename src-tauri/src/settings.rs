use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

#[derive(Debug, Default, Clone, Deserialize, Serialize)]
pub struct Settings {
    #[serde(default)]
    pub brave_api_key: Option<String>,
    #[serde(default)]
    pub gemini_api_key: Option<String>,
    #[serde(default)]
    pub share_domains: Vec<String>,
    #[serde(default)]
    pub share_domain: Option<String>,
    #[serde(default)]
    pub models: ModelConfig,
    /// Text-to-speech engine for the lecture audio button: "system" (free,
    /// built-in browser voices) or "gemini" (paid cloud TTS).
    #[serde(default)]
    pub tts_engine: Option<String>,
    /// Gemini prebuilt voice name (e.g. "Kore"). Used only when tts_engine is
    /// "gemini".
    #[serde(default)]
    pub tts_voice: Option<String>,
    /// Gemini model used to generate illustration images (Nano Banana family).
    #[serde(default)]
    pub gemini_image_model: Option<String>,
    /// Gemini model used to synthesize TTS audio.
    #[serde(default)]
    pub gemini_tts_model: Option<String>,
    /// Secret used to publish courses to the public catalog.
    #[serde(default)]
    pub catalog_upload_token: Option<String>,
    /// Debug mode: capture the full agent transcript log and show the in-app
    /// debug panel. `None` means "use the build default" (on in dev builds).
    #[serde(default)]
    pub debug_logging: Option<bool>,
    /// When false, never AI-generate illustrations — fall back to searching for
    /// real images only. `None` means the default (enabled).
    #[serde(default)]
    pub image_generation: Option<bool>,
}

/// Per-backend model + reasoning choices for each kind of task. Empty
/// model/reasoning means "use the backend default".
#[derive(Debug, Default, Clone, Deserialize, Serialize)]
pub struct ModelConfig {
    #[serde(default)]
    pub claude: BackendModels,
    #[serde(default)]
    pub codex: BackendModels,
}

#[derive(Debug, Default, Clone, Deserialize, Serialize)]
pub struct BackendModels {
    #[serde(default)]
    pub planning: StageModel,
    #[serde(default)]
    pub writing: StageModel,
    #[serde(default)]
    pub tests: StageModel,
}

#[derive(Debug, Default, Clone, Deserialize, Serialize)]
pub struct StageModel {
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub reasoning: Option<String>,
}

impl StageModel {
    /// JSON payload passed to the sidecar as `modelConfig`. Blank fields are
    /// dropped so the agent falls back to its default.
    pub fn to_json(&self) -> serde_json::Value {
        let model = self
            .model
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let reasoning = self
            .reasoning
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        serde_json::json!({ "model": model, "reasoning": reasoning })
    }
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

    pub fn gemini_api_key(&self) -> Option<String> {
        self.inner
            .lock()
            .ok()
            .and_then(|s| s.gemini_api_key.clone())
            .filter(|k| !k.trim().is_empty())
    }

    pub fn set_gemini_api_key(&self, key: Option<String>) -> std::io::Result<()> {
        {
            let mut guard = self.inner.lock().expect("settings lock");
            guard.gemini_api_key = key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty());
        }
        self.persist()
    }

    pub fn share_domains(&self) -> Vec<String> {
        self.inner
            .lock()
            .map(|s| s.share_domains.clone())
            .unwrap_or_default()
    }

    pub fn share_domain(&self) -> Option<String> {
        self.inner
            .lock()
            .ok()
            .and_then(|s| s.share_domain.clone())
            .filter(|d| !d.trim().is_empty())
    }

    pub fn set_share_domains(&self, domains: Vec<String>) -> std::io::Result<()> {
        {
            let mut guard = self.inner.lock().expect("settings lock");
            let mut cleaned: Vec<String> = Vec::new();
            for d in domains {
                let d = d.trim().to_string();
                if !d.is_empty() && !cleaned.contains(&d) {
                    cleaned.push(d);
                }
            }
            // Drop a selected domain that's no longer in the list.
            if let Some(sel) = &guard.share_domain {
                if !cleaned.contains(sel) {
                    guard.share_domain = None;
                }
            }
            guard.share_domains = cleaned;
        }
        self.persist()
    }

    pub fn set_share_domain(&self, domain: Option<String>) -> std::io::Result<()> {
        {
            let mut guard = self.inner.lock().expect("settings lock");
            guard.share_domain = domain
                .map(|d| d.trim().to_string())
                .filter(|d| !d.is_empty());
        }
        self.persist()
    }

    /// "system" (default) or "gemini".
    pub fn tts_engine(&self) -> String {
        self.inner
            .lock()
            .ok()
            .and_then(|s| s.tts_engine.clone())
            .map(|e| e.trim().to_string())
            .filter(|e| !e.is_empty())
            .unwrap_or_else(|| "system".to_string())
    }

    pub fn set_tts_engine(&self, engine: Option<String>) -> std::io::Result<()> {
        {
            let mut guard = self.inner.lock().expect("settings lock");
            guard.tts_engine = engine
                .map(|e| e.trim().to_string())
                .filter(|e| !e.is_empty());
        }
        self.persist()
    }

    pub fn tts_voice(&self) -> String {
        self.inner
            .lock()
            .ok()
            .and_then(|s| s.tts_voice.clone())
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| "Kore".to_string())
    }

    pub fn set_tts_voice(&self, voice: Option<String>) -> std::io::Result<()> {
        {
            let mut guard = self.inner.lock().expect("settings lock");
            guard.tts_voice = voice.map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        }
        self.persist()
    }

    pub fn gemini_image_model(&self) -> String {
        self.inner
            .lock()
            .ok()
            .and_then(|s| s.gemini_image_model.clone())
            .map(|m| m.trim().to_string())
            .filter(|m| !m.is_empty())
            .unwrap_or_else(|| "gemini-2.5-flash-image".to_string())
    }

    pub fn set_gemini_image_model(&self, model: Option<String>) -> std::io::Result<()> {
        {
            let mut guard = self.inner.lock().expect("settings lock");
            guard.gemini_image_model =
                model.map(|m| m.trim().to_string()).filter(|m| !m.is_empty());
        }
        self.persist()
    }

    pub fn gemini_tts_model(&self) -> String {
        self.inner
            .lock()
            .ok()
            .and_then(|s| s.gemini_tts_model.clone())
            .map(|m| m.trim().to_string())
            .filter(|m| !m.is_empty())
            .unwrap_or_else(|| "gemini-2.5-flash-preview-tts".to_string())
    }

    pub fn set_gemini_tts_model(&self, model: Option<String>) -> std::io::Result<()> {
        {
            let mut guard = self.inner.lock().expect("settings lock");
            guard.gemini_tts_model =
                model.map(|m| m.trim().to_string()).filter(|m| !m.is_empty());
        }
        self.persist()
    }

    pub fn catalog_upload_token(&self) -> Option<String> {
        self.inner
            .lock()
            .ok()
            .and_then(|s| s.catalog_upload_token.clone())
            .filter(|k| !k.trim().is_empty())
    }

    pub fn set_catalog_upload_token(&self, token: Option<String>) -> std::io::Result<()> {
        {
            let mut guard = self.inner.lock().expect("settings lock");
            guard.catalog_upload_token = token
                .map(|k| k.trim().to_string())
                .filter(|k| !k.is_empty());
        }
        self.persist()
    }

    pub fn models(&self) -> ModelConfig {
        self.inner
            .lock()
            .map(|s| s.models.clone())
            .unwrap_or_default()
    }

    /// Resolve the model/reasoning config for a backend + category as a JSON
    /// payload for the sidecar. `category` is "planning" | "writing" | "tests".
    pub fn stage_model(&self, backend: &str, category: &str) -> serde_json::Value {
        let models = self.models();
        let bm = match backend {
            "codex" => models.codex,
            _ => models.claude,
        };
        let stage = match category {
            "planning" => bm.planning,
            "tests" => bm.tests,
            _ => bm.writing,
        };
        stage.to_json()
    }

    pub fn set_models(&self, models: ModelConfig) -> std::io::Result<()> {
        {
            let mut guard = self.inner.lock().expect("settings lock");
            guard.models = models;
        }
        self.persist()
    }

    /// Whether debug logging / the debug panel are enabled. Defaults to the
    /// build type (on in dev) until the user sets it explicitly in Settings.
    pub fn debug_logging(&self) -> bool {
        self.inner
            .lock()
            .ok()
            .and_then(|s| s.debug_logging)
            .unwrap_or(cfg!(debug_assertions))
    }

    pub fn set_debug_logging(&self, enabled: bool) -> std::io::Result<()> {
        {
            let mut guard = self.inner.lock().expect("settings lock");
            guard.debug_logging = Some(enabled);
        }
        self.persist()
    }

    /// Whether AI image generation is allowed. Defaults to on; when off the
    /// illustration pipeline searches for real images only.
    pub fn image_generation(&self) -> bool {
        self.inner
            .lock()
            .ok()
            .and_then(|s| s.image_generation)
            .unwrap_or(true)
    }

    pub fn set_image_generation(&self, enabled: bool) -> std::io::Result<()> {
        {
            let mut guard = self.inner.lock().expect("settings lock");
            guard.image_generation = Some(enabled);
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

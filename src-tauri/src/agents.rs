//! Agent backend registry.
//!
//! One place for the providers the app can drive. The sidecar dispatches on the
//! same ids; keeping the list here avoids scattering `== "claude" || == "codex"`
//! checks as new agents are added.

use std::path::PathBuf;

use crate::sidecar;

#[derive(Debug, Clone, Copy)]
pub struct AgentSpec {
    pub id: &'static str,
    pub label: &'static str,
    /// CLI binary that must be installed and logged in.
    pub cli: &'static str,
    /// Alternate binary name used by some package managers.
    pub alt_cli: Option<&'static str>,
    /// Whether this agent can generate illustrations itself (Codex's
    /// `$imagegen`). Others fall back to Gemini/search.
    pub image_generation: bool,
}

pub const AGENTS: &[AgentSpec] = &[
    AgentSpec {
        id: "claude",
        label: "Claude",
        cli: "claude",
        alt_cli: None,
        image_generation: false,
    },
    AgentSpec {
        id: "codex",
        label: "Codex",
        cli: "codex",
        alt_cli: None,
        image_generation: true,
    },
    AgentSpec {
        id: "opencode",
        label: "OpenCode",
        cli: "opencode",
        alt_cli: None,
        image_generation: false,
    },
    AgentSpec {
        id: "commandcode",
        label: "Command Code",
        cli: "commandcode",
        alt_cli: Some("command-code"),
        image_generation: false,
    },
];

pub fn spec(id: &str) -> Option<&'static AgentSpec> {
    AGENTS.iter().find(|a| a.id == id)
}

pub fn is_known(id: &str) -> bool {
    spec(id).is_some()
}

/// Coerce an optional id to a known agent, defaulting to Claude (the same
/// behavior the old hard-coded `match` had).
pub fn normalize(id: Option<&str>) -> String {
    let id = id.map(str::trim).filter(|s| !s.is_empty());
    match id {
        Some(id) if is_known(id) => id.to_string(),
        _ => "claude".to_string(),
    }
}

/// Absolute path of the agent's CLI, if installed.
pub fn cli_path(agent: &AgentSpec) -> Option<PathBuf> {
    let primary = sidecar::command_path(agent.cli);
    if primary.is_absolute() {
        return Some(primary);
    }
    let alt = agent.alt_cli?;
    let path = sidecar::command_path(alt);
    path.is_absolute().then_some(path)
}

pub fn available(id: &str) -> bool {
    spec(id).and_then(cli_path).is_some()
}

/// Whether the agent can generate illustrations itself.
pub fn can_generate_images(id: &str) -> bool {
    spec(id).is_some_and(|a| a.image_generation)
}

/// Display labels for MCP capability lists.
pub fn labels() -> Vec<String> {
    AGENTS.iter().map(|a| a.label.to_string()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_unique_and_resolvable() {
        let mut seen = std::collections::HashSet::new();
        for agent in AGENTS {
            assert!(seen.insert(agent.id), "duplicate agent id: {}", agent.id);
            assert!(is_known(agent.id));
            assert_eq!(spec(agent.id).map(|a| a.id), Some(agent.id));
        }
        assert!(!is_known("nope"));
    }

    #[test]
    fn normalize_accepts_new_backends_and_falls_back() {
        assert_eq!(normalize(Some("opencode")), "opencode");
        assert_eq!(normalize(Some("commandcode")), "commandcode");
        assert_eq!(normalize(Some("unknown")), "claude");
        assert_eq!(normalize(None), "claude");
    }

    #[test]
    fn only_codex_generates_images() {
        assert!(can_generate_images("codex"));
        assert!(!can_generate_images("opencode"));
        assert!(!can_generate_images("commandcode"));
        assert!(!can_generate_images("claude"));
    }
}

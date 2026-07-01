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
    /// Which engine generates illustrations: "gemini" or "codex". `None` (or any
    /// other value) means "auto" — Gemini when a key is set, else Codex.
    #[serde(default)]
    pub image_provider: Option<String>,
    /// Global default generation cost/quality profile (tier + knobs). Courses can
    /// override per-course; default == today's behavior.
    #[serde(default)]
    pub generation_profile: GenerationProfile,
    /// Per-agent kill switches: when false the agent is reported unavailable
    /// and hidden from pickers/suggestions. `None` means enabled.
    #[serde(default)]
    pub agent_claude_enabled: Option<bool>,
    #[serde(default)]
    pub agent_codex_enabled: Option<bool>,
    /// User-registered third-party MCP servers (attachable to courses during
    /// generation). Adding one is an explicit code-execution approval: the
    /// command is shown verbatim in the UI before saving.
    #[serde(default)]
    pub custom_mcp_servers: Vec<CustomMcpServer>,
    /// Private self-hosted catalog servers (the public catalog is implicit).
    #[serde(default)]
    pub catalog_servers: Vec<CatalogServerConfig>,
    /// User-defined writing styles. Built-in presets are NOT stored here — they
    /// live in `builtin_styles()` and are merged read-only when listing.
    #[serde(default)]
    pub custom_styles: Vec<ContentStyle>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CatalogServerConfig {
    /// Slug of the name; upserting by id lets re-adding a server replace it.
    pub id: String,
    pub name: String,
    /// Normalized (trimmed, no trailing slash).
    pub base_url: String,
    /// Upload token for publishing. Never exposed to the frontend.
    #[serde(default)]
    pub token: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CustomMcpServer {
    /// Slug used as the MCP server name (tool prefix mcp__<id>__...).
    pub id: String,
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// KEY=VALUE pairs (API keys etc.) passed as the server's environment.
    #[serde(default)]
    pub env: Vec<(String, String)>,
    /// Tool names discovered by the probe (without the mcp__ prefix); used
    /// for allowlisting. Empty = allow the whole server.
    #[serde(default)]
    pub tools: Vec<String>,
    /// Where the server was found (registry/GitHub page) — provenance.
    #[serde(default)]
    pub source_url: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

/// A reusable writing voice applied to generated course material. The `guidance`
/// field is a single free-form natural-language instruction the agent follows;
/// no fixed sub-fields are imposed.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ContentStyle {
    /// Slug identifier. Preset ids are reserved with the `preset-` prefix.
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub guidance: String,
    /// Read-only built-in preset. `true` only for `builtin_styles()`; custom
    /// styles persisted in settings are always `false`.
    #[serde(default)]
    pub builtin: bool,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

/// Reserved prefix for built-in preset ids; custom styles may not collide.
pub const PRESET_ID_PREFIX: &str = "preset-";

/// The style applied when a course has no `style_id`, or its `style_id` no longer
/// resolves (e.g. the custom style was deleted). Preserves today's accessible
/// default voice.
pub const DEFAULT_STYLE_ID: &str = "preset-conversational";

fn preset(id: &str, name: &str, description: &str, guidance: &str) -> ContentStyle {
    ContentStyle {
        id: id.to_string(),
        name: name.to_string(),
        description: description.to_string(),
        guidance: guidance.to_string(),
        builtin: true,
        created_at: 0,
        updated_at: 0,
    }
}

/// Built-in, read-only style presets shipped with the app (FR-002). A broad
/// curated library covering diverse registers; users duplicate any of these to
/// customize. `preset-conversational` is the default (DEFAULT_STYLE_ID).
pub fn builtin_styles() -> Vec<ContentStyle> {
    vec![
        preset(
            "preset-academic",
            "Academic",
            "Precise scientific terminology, formal register.",
            "Write in a formal, academic register for an informed reader. Use precise, correct \
technical and scientific terminology and define each key term the first time it appears. Prefer \
full, well-structured sentences and an impartial, objective tone. Avoid slang, contractions, and \
casual asides. Support claims with clear reasoning; where a concept has an established formal name, \
use it rather than a colloquial paraphrase.",
        ),
        preset(
            "preset-conversational",
            "Conversational / Pop-sci",
            "Plain language for a broad audience.",
            "Write for a curious general audience with no special background. Use plain, everyday \
language, short sentences, and a warm, friendly tone. Explain ideas with concrete analogies and \
relatable examples. Avoid unexplained jargon — if a technical term is genuinely needed, introduce \
it in plain words first and keep it minimal. Make the topic feel approachable and interesting.",
        ),
        preset(
            "preset-storytelling",
            "Storytelling",
            "Teach through stories and examples.",
            "Teach through narrative. Open with a concrete story, scenario, or character, and let \
the concepts emerge from it. Use vivid, specific examples and a through-line that ties the lesson \
together. Keep everything accurate, but lead with story and illustration rather than dry definitions.",
        ),
        preset(
            "preset-socratic",
            "Socratic",
            "Question-driven; makes the learner think.",
            "Lead the learner by asking. Pose a guiding question, give them a moment to consider it, \
then reason toward the answer together. Use frequent questions and 'what would happen if…' prompts, \
and reveal conclusions gradually rather than stating them up front. Keep the reasoning rigorous and correct.",
        ),
        preset(
            "preset-handson",
            "Hands-on / Practical",
            "Step-by-step, action-oriented, minimal theory.",
            "Be practical and action-oriented. Favor concrete steps, short numbered procedures, and \
'do this, then that' instructions over theory. Give just the background needed to act, then get the \
learner doing. Prefer worked examples the reader can follow along with, and call out common mistakes.",
        ),
        preset(
            "preset-eli5",
            "Plain words (ELI5)",
            "Simplest possible, for absolute beginners.",
            "Explain as if to a curious 12-year-old with no background. Use the simplest words, very \
short sentences, and one familiar analogy per idea. Avoid all jargon; if a term is unavoidable, \
explain it in plain words first. Do NOT use mathematical formulas, equations, or symbolic notation \
(no Greek letters like λ, no exponents, no fractions) — always describe the relationship in ordinary \
words instead (e.g. 'shorter waves of light scatter much more strongly than longer ones'). Be \
encouraging, concrete, and patient.",
        ),
        preset(
            "preset-exam",
            "Exam crib / Concise",
            "Terse: definitions, key facts, bullets.",
            "Write as a tight revision crib. Be concise and high-density: short paragraphs, bullet \
lists, bolded key terms, crisp definitions, and the facts most likely to be tested. Skip storytelling \
and filler; prioritize clarity and recall.",
        ),
        preset(
            "preset-technical",
            "Technical / Engineering",
            "For practitioners: code-first, exact.",
            "Write for a practitioner. Be precise and exact, use correct technical terminology, and \
lead with concrete artifacts — code, commands, configs, signatures — over prose. State assumptions, \
edge cases and gotchas explicitly. Keep explanations dense and unembellished.",
        ),
        preset(
            "preset-journalistic",
            "Journalistic",
            "Clear and engaging; key point first.",
            "Write like a good explanatory journalist. Lead with the key point, then unpack the \
details (inverted pyramid). Keep sentences clear and active, ground claims in concrete specifics, and \
stay engaging without hype. Be accurate, brisk, and readable.",
        ),
        preset(
            "preset-business",
            "Business / Executive",
            "Outcomes and decisions, no fluff.",
            "Write for a busy decision-maker. Lead with the takeaway and why it matters. Emphasize \
outcomes, trade-offs, costs and decisions; cut theory and filler. Use crisp headings and short, \
skimmable sections.",
        ),
        preset(
            "preset-historical",
            "Historical / Contextual",
            "Through the evolution of ideas.",
            "Teach through the evolution of the idea. Explain how the concept emerged, what problem \
it solved, and how it changed over time. Use dates, people and context to make it memorable, while \
keeping the underlying explanation correct and clear.",
        ),
        preset(
            "preset-rigorous",
            "Rigorous / Proof-based",
            "Derivations and mathematical rigor.",
            "Write with mathematical rigor for a STEM reader. State definitions precisely, give \
derivations and proofs step by step, and justify each claim. Use correct notation and LaTeX. Prefer \
exactness over hand-waving, while still explaining the underlying intuition.",
        ),
        preset(
            "preset-mentor",
            "Friendly mentor",
            "Warm, patient, like a 1:1 tutor.",
            "Write like a warm, patient one-to-one tutor. Address the learner directly and \
supportively, anticipate where they might get stuck, and reassure them. Build confidence with small \
wins and check-ins, while keeping the explanation clear and correct.",
        ),
        preset(
            "preset-motivational",
            "Motivational / Energetic",
            "Encouraging, high-energy tone.",
            "Write with energy and encouragement. Keep the tone upbeat and momentum-building, \
celebrate progress, and frame challenges as exciting. Stay substantive and accurate — the enthusiasm \
supports the learning, it never replaces it.",
        ),
    ]
}

/// Length caps for a custom style (defensive: keeps the prompt bounded).
pub const STYLE_NAME_MAX: usize = 80;
pub const STYLE_GUIDANCE_MAX: usize = 4000;

/// Validate a custom style before saving (FR-014). Pure — unit-tested.
pub fn validate_style(style: &ContentStyle) -> Result<(), String> {
    let name = style.name.trim();
    let guidance = style.guidance.trim();
    if name.is_empty() {
        return Err("Style name cannot be empty.".to_string());
    }
    if guidance.is_empty() {
        return Err("Style guidance cannot be empty.".to_string());
    }
    if name.chars().count() > STYLE_NAME_MAX {
        return Err(format!("Style name is too long (max {STYLE_NAME_MAX} characters)."));
    }
    if guidance.chars().count() > STYLE_GUIDANCE_MAX {
        return Err(format!(
            "Style guidance is too long (max {STYLE_GUIDANCE_MAX} characters)."
        ));
    }
    Ok(())
}

/// Resolve a course's `style_id` against the merged preset + custom list. `None`,
/// blank, or a dangling/deleted id all fall back to the default style so existing
/// courses never break (FR-005/FR-012). Pure — unit-tested.
pub fn resolve_style(style_id: Option<&str>, custom: &[ContentStyle]) -> ContentStyle {
    let id = style_id.map(str::trim).filter(|s| !s.is_empty());
    if let Some(id) = id {
        if let Some(found) = builtin_styles().into_iter().find(|s| s.id == id) {
            return found;
        }
        if let Some(found) = custom.iter().find(|s| s.id == id) {
            return found.clone();
        }
    }
    builtin_styles()
        .into_iter()
        .find(|s| s.id == DEFAULT_STYLE_ID)
        .expect("default preset must exist")
}

/// Slugify a style name into an id candidate (lowercase, hyphen-separated).
pub fn slugify_style(name: &str) -> String {
    let slug: String = name
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let slug = slug.trim_matches('-').to_string();
    let collapsed = slug
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if collapsed.is_empty() {
        "style".to_string()
    } else {
        collapsed
    }
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
    /// Interactive helpers: course assistant, editor rewrites, fix-widget —
    /// latency matters more than depth.
    #[serde(default)]
    pub assistant: StageModel,
    /// Small fast calls: wizard questions, card grading, profile extraction.
    /// Empty model => the sidecar auto-picks the cheapest available
    /// (preferCheap flag).
    #[serde(default)]
    pub utility: StageModel,
    /// Post-ready fact-check pass.
    #[serde(default)]
    pub verify: StageModel,
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

/// Generation cost/quality profile. One object that bundles the cost tier with
/// orthogonal knobs; blank knobs are resolved from the active tier's preset, so
/// the default (tier "balanced", all knobs unset) reproduces today's behavior.
#[derive(Debug, Default, Clone, Deserialize, Serialize)]
pub struct GenerationProfile {
    /// "quick" | "balanced" | "premium" (blank => balanced).
    #[serde(default)]
    pub tier: String,
    /// "lean" | "standard" | "max" — how much pedagogy scaffolding to apply.
    #[serde(default)]
    pub pedagogy_intensity: Option<String>,
    /// "light" | "normal" | "deep" — research turns + web during planning/draft.
    #[serde(default)]
    pub research_depth: Option<String>,
    /// "off" | "search" | "full" — illustration pass behavior.
    #[serde(default)]
    pub illustration_mode: Option<String>,
    #[serde(default)]
    pub skip_tests: Option<bool>,
    #[serde(default)]
    pub skip_assignments: Option<bool>,
    /// Skip the clarifying-questions interview: generate only the title and go
    /// straight to plan building.
    #[serde(default)]
    pub skip_wizard: Option<bool>,
    /// Run the clarifying-questions interview AND the structure build in ONE
    /// reused agent session per course (on the planning model) so the shared
    /// topic prefix is prompt-cached across calls. Default ON; turn off to
    /// spawn a fresh agent per call (more variety, no cache reuse).
    #[serde(default)]
    pub reuse_thread_per_topic: Option<bool>,
    /// Id of the writing style applied to this course's material. Blank/None or a
    /// dangling id resolves to `DEFAULT_STYLE_ID`.
    #[serde(default)]
    pub style_id: Option<String>,
    /// Skip the style-review editorial pass. Mirrors `skip_tests`: absent/false
    /// means the pass runs (toggle default ON, FR-006).
    #[serde(default)]
    pub skip_style_review: Option<bool>,
}

/// Resolved defaults for one cost tier. The model/reasoning cascade is added
/// later once the sidecar's accepted reasoning values are confirmed; for now a
/// tier only tunes non-model knobs, so adding this changes nothing at runtime
/// until `lib.rs` reads the resolved knobs.
pub struct TierPreset {
    pub pedagogy_intensity: &'static str,
    pub research_depth: &'static str,
    pub illustration_mode: &'static str,
    pub skip_assignments: bool,
    pub max_test_questions: u8,
    // Reasoning-effort cascade per stage. None == leave the agent default
    // (balanced). Model NAMES are deliberately not set — they're dynamic per the
    // user's CLI install, so reasoning effort is the safe cost lever (mirrors
    // fast_model_config in lib.rs). Both agents accept off/low/medium/high/...
    pub planning_reasoning: Option<&'static str>,
    pub writing_reasoning: Option<&'static str>,
    pub tests_reasoning: Option<&'static str>,
    pub assistant_reasoning: Option<&'static str>,
    pub utility_reasoning: Option<&'static str>,
    pub verify_reasoning: Option<&'static str>,
}

/// Categories where accuracy matters most — the cheap-tier safety floor forbids
/// dropping web research below "normal" here regardless of tier.
/// (Distinct from FACT_CHECK_ALWAYS_CATEGORIES, which gates the post-ready
/// verification pass.)
pub const ACCURACY_CRITICAL_CATEGORIES: &[&str] =
    &["science_math", "health", "business"];

/// Categories that ALWAYS get the background fact-check pass, regardless of
/// tier. data_ai is included: version/benchmark claims rot fastest.
pub const FACT_CHECK_ALWAYS_CATEGORIES: &[&str] =
    &["science_math", "health", "business", "data_ai"];

pub fn normalize_gen_tier(value: Option<&str>) -> &'static str {
    match value.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
        Some("quick") => "quick",
        Some("premium") => "premium",
        _ => "balanced",
    }
}

pub fn tier_preset(tier: &str) -> TierPreset {
    match normalize_gen_tier(Some(tier)) {
        "quick" => TierPreset {
            pedagogy_intensity: "lean",
            research_depth: "light",
            illustration_mode: "search",
            skip_assignments: true,
            max_test_questions: 5,
            // Trim thinking; keep the dominant draft (writing) at a usable level.
            planning_reasoning: Some("low"),
            writing_reasoning: Some("medium"),
            tests_reasoning: Some("low"),
            assistant_reasoning: Some("low"),
            utility_reasoning: Some("low"),
            verify_reasoning: Some("low"),
        },
        "premium" => TierPreset {
            pedagogy_intensity: "max",
            research_depth: "deep",
            illustration_mode: "full",
            skip_assignments: false,
            max_test_questions: 8,
            planning_reasoning: Some("high"),
            writing_reasoning: Some("high"),
            tests_reasoning: Some("medium"),
            assistant_reasoning: Some("medium"),
            // Utility stays cheap on every tier — these are mechanical calls.
            utility_reasoning: Some("low"),
            verify_reasoning: Some("medium"),
        },
        // balanced (default) == today's behavior (no reasoning override)
        _ => TierPreset {
            pedagogy_intensity: "standard",
            research_depth: "normal",
            illustration_mode: "full",
            skip_assignments: false,
            max_test_questions: 6,
            planning_reasoning: None,
            writing_reasoning: None,
            tests_reasoning: None,
            assistant_reasoning: None,
            utility_reasoning: Some("low"),
            verify_reasoning: None,
        },
    }
}

fn nonblank(v: &Option<String>) -> Option<&str> {
    v.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

impl GenerationProfile {
    pub fn tier(&self) -> &'static str {
        normalize_gen_tier(Some(&self.tier))
    }

    pub fn pedagogy_intensity(&self) -> String {
        nonblank(&self.pedagogy_intensity)
            .map(str::to_string)
            .unwrap_or_else(|| tier_preset(self.tier()).pedagogy_intensity.to_string())
    }

    /// Research depth, honoring the cheap-tier safety floor for accuracy-critical
    /// categories: never below "normal" there.
    pub fn research_depth(&self, category: Option<&str>) -> String {
        let mut depth = nonblank(&self.research_depth)
            .map(str::to_string)
            .unwrap_or_else(|| tier_preset(self.tier()).research_depth.to_string());
        let critical = category
            .map(|c| ACCURACY_CRITICAL_CATEGORIES.contains(&c))
            .unwrap_or(false);
        if critical && depth == "light" {
            depth = "normal".to_string();
        }
        depth
    }

    /// Planning/draft research turn budget derived from the resolved depth.
    pub fn research_max_turns(&self, category: Option<&str>) -> u32 {
        match self.research_depth(category).as_str() {
            "light" => 4,
            "deep" => 16,
            _ => 10,
        }
    }

    /// Whether this lesson gets the background fact-check pass: always for
    /// accuracy-critical categories, otherwise on every tier except "quick".
    pub fn should_fact_check(&self, category: Option<&str>) -> bool {
        let critical = category
            .map(|c| FACT_CHECK_ALWAYS_CATEGORIES.contains(&c))
            .unwrap_or(false);
        critical || self.tier() != "quick"
    }

    /// Draft-stage research budget: halved when a course research pack exists —
    /// the pack carries pre-verified grounding, so the draft only verifies
    /// lesson-specific specifics. The structure stage keeps the full budget.
    pub fn draft_research_max_turns(&self, category: Option<&str>, has_pack: bool) -> u32 {
        let full = self.research_max_turns(category);
        if has_pack {
            // The pack covers fact research, but the draft still spends turns
            // hunting widgets (videos with quality signals, real screenshots)
            // AND running the editor fact-check pass (more web). A floor of 8
            // still hit the "maximum number of turns" error on balanced tier
            // (the SDK aborts with no article instead of returning partial work).
            // Never give a pack draft LESS than the known-good non-pack budget
            // (normal = 10, which has no reported failures), so floor at 10.
            (full / 2).max(10).min(full)
        } else {
            full
        }
    }

    pub fn illustration_mode(&self) -> String {
        nonblank(&self.illustration_mode)
            .map(str::to_string)
            .unwrap_or_else(|| tier_preset(self.tier()).illustration_mode.to_string())
    }

    pub fn skip_tests(&self) -> bool {
        self.skip_tests.unwrap_or(false)
    }

    /// Whether the style-review editorial pass runs. Default ON (FR-006).
    pub fn skip_style_review(&self) -> bool {
        self.skip_style_review.unwrap_or(false)
    }

    /// The selected style id, if any (blank treated as None).
    pub fn style_id(&self) -> Option<String> {
        nonblank(&self.style_id).map(str::to_string)
    }

    pub fn skip_assignments(&self) -> bool {
        self.skip_assignments
            .unwrap_or_else(|| tier_preset(self.tier()).skip_assignments)
    }

    /// Whether the wizard + structure stages reuse one agent session per course
    /// (prompt-cache friendly). Default ON.
    pub fn reuse_thread_per_topic(&self) -> bool {
        self.reuse_thread_per_topic.unwrap_or(true)
    }

    pub fn max_test_questions(&self) -> u8 {
        tier_preset(self.tier()).max_test_questions
    }

    /// Reasoning-effort override for a stage ("planning" | "writing" | "tests"
    /// | "assistant" | "utility" | "verify"), or None to leave the agent
    /// default.
    pub fn stage_reasoning(&self, stage: &str) -> Option<&'static str> {
        let p = tier_preset(self.tier());
        match stage {
            "planning" => p.planning_reasoning,
            "tests" => p.tests_reasoning,
            "assistant" => p.assistant_reasoning,
            "utility" => p.utility_reasoning,
            "verify" => p.verify_reasoning,
            _ => p.writing_reasoning,
        }
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
            "assistant" => bm.assistant,
            "utility" => bm.utility,
            "verify" => bm.verify,
            _ => bm.writing,
        };
        let no_model = stage
            .model
            .as_deref()
            .map(str::trim)
            .map(str::is_empty)
            .unwrap_or(true);
        let mut json = stage.to_json();
        // Utility calls with no explicit model: let the sidecar auto-pick the
        // cheapest available model (haiku-* / *-mini), falling back to default.
        if category == "utility" && no_model {
            if let serde_json::Value::Object(map) = &mut json {
                map.insert("preferCheap".to_string(), serde_json::json!(true));
            }
        }
        json
    }

    pub fn set_models(&self, models: ModelConfig) -> std::io::Result<()> {
        {
            let mut guard = self.inner.lock().expect("settings lock");
            guard.models = models;
        }
        self.persist()
    }

    /// Global default generation profile.
    pub fn generation_profile(&self) -> GenerationProfile {
        self.inner
            .lock()
            .map(|s| s.generation_profile.clone())
            .unwrap_or_default()
    }

    pub fn set_generation_profile(&self, profile: GenerationProfile) -> std::io::Result<()> {
        {
            let mut guard = self.inner.lock().expect("settings lock");
            guard.generation_profile = profile;
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

    /// Which engine generates illustrations: "auto" | "gemini" | "codex".
    pub fn image_provider(&self) -> String {
        self.inner
            .lock()
            .ok()
            .and_then(|s| s.image_provider.clone())
            .map(|p| p.trim().to_lowercase())
            .filter(|p| p == "gemini" || p == "codex")
            .unwrap_or_else(|| "auto".to_string())
    }

    pub fn set_image_provider(&self, provider: String) -> std::io::Result<()> {
        {
            let mut guard = self.inner.lock().expect("settings lock");
            let p = provider.trim().to_lowercase();
            // Store only explicit engines; "auto" (the default) is kept as None.
            guard.image_provider = match p.as_str() {
                "gemini" | "codex" => Some(p),
                _ => None,
            };
        }
        self.persist()
    }

    /// Whether the agent is enabled in settings ("claude" | "codex").
    /// Defaults to on; independent of whether the agent's CLI is installed.
    pub fn agent_enabled(&self, agent: &str) -> bool {
        self.inner
            .lock()
            .ok()
            .and_then(|s| match agent {
                "claude" => s.agent_claude_enabled,
                "codex" => s.agent_codex_enabled,
                _ => None,
            })
            .unwrap_or(true)
    }

    pub fn set_agent_enabled(&self, agent: &str, enabled: bool) -> std::io::Result<()> {
        {
            let mut guard = self.inner.lock().expect("settings lock");
            match agent {
                "claude" => guard.agent_claude_enabled = Some(enabled),
                "codex" => guard.agent_codex_enabled = Some(enabled),
                _ => {}
            }
        }
        self.persist()
    }

    pub fn custom_mcp_servers(&self) -> Vec<CustomMcpServer> {
        self.inner
            .lock()
            .map(|s| s.custom_mcp_servers.clone())
            .unwrap_or_default()
    }

    /// Insert or replace (by id) a custom MCP server.
    pub fn upsert_custom_mcp(&self, server: CustomMcpServer) -> std::io::Result<()> {
        {
            let mut guard = self.inner.lock().expect("settings lock");
            guard.custom_mcp_servers.retain(|s| s.id != server.id);
            guard.custom_mcp_servers.push(server);
        }
        self.persist()
    }

    pub fn delete_custom_mcp(&self, id: &str) -> std::io::Result<()> {
        {
            let mut guard = self.inner.lock().expect("settings lock");
            guard.custom_mcp_servers.retain(|s| s.id != id);
        }
        self.persist()
    }

    pub fn set_custom_mcp_enabled(&self, id: &str, enabled: bool) -> std::io::Result<()> {
        {
            let mut guard = self.inner.lock().expect("settings lock");
            for s in guard.custom_mcp_servers.iter_mut() {
                if s.id == id {
                    s.enabled = enabled;
                }
            }
        }
        self.persist()
    }

    /// User-defined custom styles (raw, without presets).
    pub fn custom_styles(&self) -> Vec<ContentStyle> {
        self.inner
            .lock()
            .map(|s| s.custom_styles.clone())
            .unwrap_or_default()
    }

    /// All styles for listing: read-only presets first, then custom styles.
    pub fn content_styles(&self) -> Vec<ContentStyle> {
        let mut all = builtin_styles();
        all.extend(self.custom_styles());
        all
    }

    /// Resolve a course's `style_id` to a concrete style (preset or custom),
    /// falling back to the default for None/blank/dangling ids.
    pub fn resolve_style(&self, style_id: Option<&str>) -> ContentStyle {
        resolve_style(style_id, &self.custom_styles())
    }

    /// Insert or replace (by id) a custom style. The caller is responsible for
    /// validation and for ensuring `id` is not a preset id.
    pub fn upsert_custom_style(&self, style: ContentStyle) -> std::io::Result<()> {
        {
            let mut guard = self.inner.lock().expect("settings lock");
            guard.custom_styles.retain(|s| s.id != style.id);
            guard.custom_styles.push(style);
        }
        self.persist()
    }

    pub fn delete_custom_style(&self, id: &str) -> std::io::Result<()> {
        {
            let mut guard = self.inner.lock().expect("settings lock");
            guard.custom_styles.retain(|s| s.id != id);
        }
        self.persist()
    }

    pub fn catalog_servers(&self) -> Vec<CatalogServerConfig> {
        self.inner
            .lock()
            .map(|s| s.catalog_servers.clone())
            .unwrap_or_default()
    }

    /// Insert or replace (by id) a private catalog server.
    pub fn upsert_catalog_server(&self, server: CatalogServerConfig) -> std::io::Result<()> {
        {
            let mut guard = self.inner.lock().expect("settings lock");
            guard.catalog_servers.retain(|s| s.id != server.id);
            guard.catalog_servers.push(server);
        }
        self.persist()
    }

    pub fn delete_catalog_server(&self, id: &str) -> std::io::Result<()> {
        {
            let mut guard = self.inner.lock().expect("settings lock");
            guard.catalog_servers.retain(|s| s.id != id);
        }
        self.persist()
    }

    /// Look up a private catalog server by its normalized base URL.
    pub fn catalog_server_by_url(&self, base_url: &str) -> Option<CatalogServerConfig> {
        let needle = crate::catalog::normalize_base_url(base_url);
        self.inner.lock().ok().and_then(|s| {
            s.catalog_servers
                .iter()
                .find(|c| crate::catalog::normalize_base_url(&c.base_url) == needle)
                .cloned()
        })
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

#[cfg(test)]
mod content_style_tests {
    use super::*;

    fn custom(id: &str, name: &str, guidance: &str) -> ContentStyle {
        ContentStyle {
            id: id.to_string(),
            name: name.to_string(),
            description: String::new(),
            guidance: guidance.to_string(),
            builtin: false,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn validate_rejects_empty_name() {
        let s = custom("x", "   ", "some guidance");
        assert!(validate_style(&s).is_err());
    }

    #[test]
    fn validate_rejects_empty_guidance() {
        let s = custom("x", "My Style", "   ");
        assert!(validate_style(&s).is_err());
    }

    #[test]
    fn validate_accepts_valid_style() {
        let s = custom("x", "My Style", "Write plainly.");
        assert!(validate_style(&s).is_ok());
    }

    #[test]
    fn validate_rejects_too_long_name() {
        let s = custom("x", &"a".repeat(STYLE_NAME_MAX + 1), "ok");
        assert!(validate_style(&s).is_err());
    }

    #[test]
    fn validate_rejects_too_long_guidance() {
        let s = custom("x", "Name", &"a".repeat(STYLE_GUIDANCE_MAX + 1));
        assert!(validate_style(&s).is_err());
    }

    #[test]
    fn resolve_known_preset_id() {
        let style = resolve_style(Some("preset-academic"), &[]);
        assert_eq!(style.id, "preset-academic");
        assert!(style.builtin);
    }

    #[test]
    fn resolve_known_custom_id() {
        let customs = vec![custom("mine", "Mine", "Casual.")];
        let style = resolve_style(Some("mine"), &customs);
        assert_eq!(style.id, "mine");
        assert!(!style.builtin);
    }

    #[test]
    fn resolve_unset_id_returns_default() {
        let style = resolve_style(None, &[]);
        assert_eq!(style.id, DEFAULT_STYLE_ID);
    }

    #[test]
    fn resolve_blank_id_returns_default() {
        let style = resolve_style(Some("   "), &[]);
        assert_eq!(style.id, DEFAULT_STYLE_ID);
    }

    #[test]
    fn resolve_dangling_id_returns_default() {
        // A deleted custom style: id present but not in the list.
        let style = resolve_style(Some("deleted-style"), &[]);
        assert_eq!(style.id, DEFAULT_STYLE_ID);
    }

    #[test]
    fn slugify_basic() {
        assert_eq!(slugify_style("My Cool Style!"), "my-cool-style");
        assert_eq!(slugify_style("   "), "style");
    }
}

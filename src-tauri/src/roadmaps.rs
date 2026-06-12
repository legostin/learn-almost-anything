// Roadmap content model + installation. A roadmap is a vertical sequence of
// stages; each stage holds node cards with curated sources and a set of
// skills. Skills link to generated lessons/courses via
// courses.roadmap_id / courses.roadmap_skill. The whole body lives as JSON in
// roadmaps.content — nodes/skills never need per-row DB queries.
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::courses::QnA;
use crate::db;

// ── Sidecar payload (no ids) ────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct SidecarRoadmapSkill {
    pub title: String,
    #[serde(default)]
    pub desc: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SidecarRoadmapSource {
    pub title: String,
    pub url: String,
    #[serde(default)]
    pub kind: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SidecarRoadmapNode {
    pub title: String,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub sources: Vec<SidecarRoadmapSource>,
    #[serde(default)]
    pub skills: Vec<SidecarRoadmapSkill>,
}

#[derive(Debug, Deserialize)]
pub struct SidecarRoadmapStage {
    pub title: String,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub nodes: Vec<SidecarRoadmapNode>,
}

#[derive(Debug, Deserialize)]
pub struct SidecarRoadmap {
    #[serde(default)]
    pub title: Option<String>,
    pub stages: Vec<SidecarRoadmapStage>,
}

// ── Stored content (with ids) ───────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RoadmapSkill {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub desc: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RoadmapSource {
    pub title: String,
    pub url: String,
    /// "docs" | "article" | "video" | "course" | "book"
    pub kind: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RoadmapNode {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub summary: String,
    pub sources: Vec<RoadmapSource>,
    pub skills: Vec<RoadmapSkill>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RoadmapStage {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub summary: String,
    pub nodes: Vec<RoadmapNode>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RoadmapContent {
    pub stages: Vec<RoadmapStage>,
}

const SOURCE_KINDS: &[&str] = &["docs", "article", "video", "course", "book"];

/// Assign UUIDs, sanitize, persist content and flip status to ready.
/// Errors when the sidecar produced an effectively empty roadmap so the
/// caller's retry loop kicks in.
pub fn install_roadmap(
    conn: &rusqlite::Connection,
    roadmap_id: &str,
    raw: SidecarRoadmap,
    now: i64,
) -> Result<RoadmapContent, String> {
    let stages: Vec<RoadmapStage> = raw
        .stages
        .into_iter()
        .filter(|s| !s.title.trim().is_empty())
        .map(|s| RoadmapStage {
            id: Uuid::new_v4().to_string(),
            title: s.title.trim().to_string(),
            summary: s.summary.unwrap_or_default().trim().to_string(),
            nodes: s
                .nodes
                .into_iter()
                .filter(|n| !n.title.trim().is_empty())
                .map(|n| RoadmapNode {
                    id: Uuid::new_v4().to_string(),
                    title: n.title.trim().to_string(),
                    summary: n.summary.unwrap_or_default().trim().to_string(),
                    sources: n
                        .sources
                        .into_iter()
                        .filter(|src| {
                            src.url.trim().starts_with("http") && !src.title.trim().is_empty()
                        })
                        .map(|src| RoadmapSource {
                            title: src.title.trim().to_string(),
                            url: src.url.trim().to_string(),
                            kind: src
                                .kind
                                .as_deref()
                                .map(str::trim)
                                .filter(|k| SOURCE_KINDS.contains(k))
                                .unwrap_or("article")
                                .to_string(),
                        })
                        .collect(),
                    skills: n
                        .skills
                        .into_iter()
                        .filter(|sk| !sk.title.trim().is_empty())
                        .map(|sk| RoadmapSkill {
                            id: Uuid::new_v4().to_string(),
                            title: sk.title.trim().to_string(),
                            desc: sk.desc.unwrap_or_default().trim().to_string(),
                        })
                        .collect(),
                })
                .collect(),
        })
        .filter(|s: &RoadmapStage| !s.nodes.is_empty())
        .collect();

    if stages.is_empty() {
        return Err("sidecar returned an empty roadmap".to_string());
    }

    if let Some(title) = raw.title.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        db::set_roadmap_title(conn, roadmap_id, title, now).map_err(|e| e.to_string())?;
    }
    let content = RoadmapContent { stages };
    let json = serde_json::to_string(&content).expect("serialize roadmap content");
    db::set_roadmap_content(conn, roadmap_id, &json, now).map_err(|e| e.to_string())?;
    db::set_roadmap_status(conn, roadmap_id, "ready", None, now).map_err(|e| e.to_string())?;
    Ok(content)
}

// ── Refinement payload (items may carry ids to preserve) ────────────────────

#[derive(Debug, Deserialize)]
pub struct RefinedSkill {
    #[serde(default)]
    pub id: Option<String>,
    pub title: String,
    #[serde(default)]
    pub desc: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct RefinedNode {
    #[serde(default)]
    pub id: Option<String>,
    pub title: String,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub sources: Vec<SidecarRoadmapSource>,
    #[serde(default)]
    pub skills: Vec<RefinedSkill>,
}

#[derive(Debug, Deserialize)]
pub struct RefinedStage {
    #[serde(default)]
    pub id: Option<String>,
    pub title: String,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub nodes: Vec<RefinedNode>,
}

#[derive(Debug, Deserialize)]
pub struct RefinedContent {
    pub stages: Vec<RefinedStage>,
}

fn keep_or_new_id(id: &Option<String>) -> String {
    id.as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| Uuid::new_v4().to_string())
}

/// Install a refinement proposal: same sanitation as install_roadmap, but
/// PRESERVES the ids the model kept (course links and done-marks hang on
/// them) and only mints UUIDs for new items. Prunes manual done-marks of
/// skills that no longer exist.
pub fn install_refined_content(
    conn: &rusqlite::Connection,
    roadmap_id: &str,
    raw: RefinedContent,
    now: i64,
) -> Result<RoadmapContent, String> {
    let stages: Vec<RoadmapStage> = raw
        .stages
        .into_iter()
        .filter(|s| !s.title.trim().is_empty())
        .map(|s| RoadmapStage {
            id: keep_or_new_id(&s.id),
            title: s.title.trim().to_string(),
            summary: s.summary.unwrap_or_default().trim().to_string(),
            nodes: s
                .nodes
                .into_iter()
                .filter(|n| !n.title.trim().is_empty())
                .map(|n| RoadmapNode {
                    id: keep_or_new_id(&n.id),
                    title: n.title.trim().to_string(),
                    summary: n.summary.unwrap_or_default().trim().to_string(),
                    sources: n
                        .sources
                        .into_iter()
                        .filter(|src| {
                            src.url.trim().starts_with("http") && !src.title.trim().is_empty()
                        })
                        .map(|src| RoadmapSource {
                            title: src.title.trim().to_string(),
                            url: src.url.trim().to_string(),
                            kind: src
                                .kind
                                .as_deref()
                                .map(str::trim)
                                .filter(|k| SOURCE_KINDS.contains(k))
                                .unwrap_or("article")
                                .to_string(),
                        })
                        .collect(),
                    skills: n
                        .skills
                        .into_iter()
                        .filter(|sk| !sk.title.trim().is_empty())
                        .map(|sk| RoadmapSkill {
                            id: keep_or_new_id(&sk.id),
                            title: sk.title.trim().to_string(),
                            desc: sk.desc.unwrap_or_default().trim().to_string(),
                        })
                        .collect(),
                })
                .collect(),
        })
        .filter(|s: &RoadmapStage| !s.nodes.is_empty())
        .collect();

    if stages.is_empty() {
        return Err("refinement produced an empty roadmap".to_string());
    }

    let content = RoadmapContent { stages };
    let alive: Vec<String> = content
        .stages
        .iter()
        .flat_map(|st| st.nodes.iter())
        .flat_map(|n| n.skills.iter())
        .map(|sk| sk.id.clone())
        .collect();
    let json = serde_json::to_string(&content).expect("serialize roadmap content");
    db::set_roadmap_content(conn, roadmap_id, &json, now).map_err(|e| e.to_string())?;
    db::prune_done_skills(conn, roadmap_id, &alive).map_err(|e| e.to_string())?;
    Ok(content)
}

/// Markdown brief fed to the build prompt: the goal plus the clarifying
/// interview (mirrors courses::render_course_md).
pub fn render_roadmap_wizard_md(roadmap: &db::Roadmap, answers: &[QnA]) -> String {
    let mut out = String::new();
    out.push_str("---\n");
    out.push_str(&format!("id: {}\n", roadmap.id));
    if let Some(title) = roadmap.title.as_deref().filter(|s| !s.trim().is_empty()) {
        out.push_str(&format!("title: {}\n", title.trim()));
    }
    out.push_str(&format!("goal: {}\n", roadmap.topic));
    out.push_str(&format!("language: {}\n", roadmap.language));
    out.push_str("---\n\n");

    out.push_str("## Learning goal\n");
    out.push_str(&roadmap.topic);
    out.push_str("\n\n");

    out.push_str("## Clarifying interview\n\n");
    for qa in answers {
        out.push_str("**Q:** ");
        out.push_str(qa.question.trim());
        out.push_str("\n\n**A:** ");
        out.push_str(qa.answer.trim());
        out.push_str("\n\n");
    }
    out
}

/// Pull the answered Q&A out of the persisted wizard dialog JSON.
pub fn answers_from_wizard(roadmap: &db::Roadmap) -> Vec<QnA> {
    roadmap
        .wizard
        .as_ref()
        .and_then(|w| w.get("answered"))
        .and_then(|a| serde_json::from_value::<Vec<QnA>>(a.clone()).ok())
        .unwrap_or_default()
}

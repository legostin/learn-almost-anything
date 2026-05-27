use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::db;

pub struct AppPaths {
    pub courses_root: PathBuf,
}

impl AppPaths {
    pub fn course_dir(&self, course_id: &str) -> PathBuf {
        self.courses_root.join(course_id)
    }
}

#[derive(Debug, Deserialize, Serialize)]
pub struct QnA {
    pub question: String,
    pub answer: String,
}

#[derive(Debug, thiserror::Error)]
pub enum CourseError {
    #[error("course not found: {0}")]
    NotFound(String),
    #[error(transparent)]
    Db(#[from] rusqlite::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("system clock before unix epoch")]
    Clock,
}

fn now_secs() -> Result<i64, CourseError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .map_err(|_| CourseError::Clock)
}

fn render_course_md(course: &db::Course, answers: &[QnA]) -> String {
    let mut out = String::new();
    out.push_str("---\n");
    out.push_str(&format!("id: {}\n", course.id));
    out.push_str(&format!("topic: {}\n", course.topic));
    out.push_str(&format!("language: {}\n", course.language));
    out.push_str(&format!("created_at: {}\n", course.created_at));
    out.push_str("---\n\n");

    out.push_str("## Topic\n");
    out.push_str(&course.topic);
    out.push_str("\n\n");

    out.push_str("## Wizard Q&A\n\n");
    for qa in answers {
        out.push_str("**Q:** ");
        out.push_str(qa.question.trim());
        out.push_str("\n\n**A:** ");
        out.push_str(qa.answer.trim());
        out.push_str("\n\n");
    }
    out
}

pub fn save_wizard_answers(
    conn: &rusqlite::Connection,
    paths: &AppPaths,
    course_id: &str,
    answers: &[QnA],
) -> Result<(), CourseError> {
    let course = db::get_course(conn, course_id)?
        .ok_or_else(|| CourseError::NotFound(course_id.to_string()))?;

    let dir = paths.course_dir(&course.id);
    fs::create_dir_all(&dir)?;
    let md = render_course_md(&course, answers);
    fs::write(dir.join("course.md"), md)?;

    db::set_course_status(conn, &course.id, "structuring", now_secs()?)?;
    Ok(())
}

pub fn read_course_md(paths: &AppPaths, course_id: &str) -> Result<String, CourseError> {
    let path = paths.course_dir(course_id).join("course.md");
    Ok(fs::read_to_string(path)?)
}

#[derive(Debug, Deserialize)]
pub struct SidecarSubmodule {
    pub title: String,
    #[serde(default)]
    pub summary: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SidecarModule {
    pub title: String,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub submodules: Vec<SidecarSubmodule>,
}

#[derive(Debug, Deserialize)]
pub struct SidecarTree {
    pub modules: Vec<SidecarModule>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModuleNode {
    pub id: String,
    pub title: String,
    pub summary: String,
    pub submodules: Vec<ModuleNode>,
}

#[derive(Debug, Serialize)]
pub struct StructureFile {
    pub course_id: String,
    pub modules: Vec<ModuleNode>,
}

pub fn install_structure(
    conn: &rusqlite::Connection,
    paths: &AppPaths,
    course_id: &str,
    raw: SidecarTree,
) -> Result<StructureFile, CourseError> {
    // assign UUIDs in a single pass
    let modules: Vec<ModuleNode> = raw
        .modules
        .into_iter()
        .map(|m| ModuleNode {
            id: Uuid::new_v4().to_string(),
            title: m.title,
            summary: m.summary.unwrap_or_default(),
            submodules: m
                .submodules
                .into_iter()
                .map(|s| ModuleNode {
                    id: Uuid::new_v4().to_string(),
                    title: s.title,
                    summary: s.summary.unwrap_or_default(),
                    submodules: vec![],
                })
                .collect(),
        })
        .collect();

    let file = StructureFile {
        course_id: course_id.to_string(),
        modules,
    };

    // 1. write structure.json
    let dir = paths.course_dir(course_id);
    fs::create_dir_all(&dir)?;
    let json = serde_json::to_string_pretty(&file).expect("serialize structure");
    fs::write(dir.join("structure.json"), json)?;

    // 2. replace modules in DB (deterministic from file)
    db::delete_modules_for_course(conn, course_id)?;
    for (mod_pos, m) in file.modules.iter().enumerate() {
        db::insert_module(
            conn,
            &m.id,
            course_id,
            None,
            mod_pos as i64,
            &m.title,
            if m.summary.is_empty() { None } else { Some(&m.summary) },
            "pending",
        )?;
        for (sub_pos, s) in m.submodules.iter().enumerate() {
            db::insert_module(
                conn,
                &s.id,
                course_id,
                Some(&m.id),
                sub_pos as i64,
                &s.title,
                if s.summary.is_empty() { None } else { Some(&s.summary) },
                "pending",
            )?;
        }
    }

    db::set_course_status(conn, course_id, "ready", now_secs()?)?;
    Ok(file)
}

#[derive(Debug, Deserialize)]
pub struct ModuleUpdate {
    #[serde(default)]
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub submodules: Vec<ModuleUpdate>,
}

pub fn save_structure(
    conn: &mut rusqlite::Connection,
    paths: &AppPaths,
    course_id: &str,
    incoming: Vec<ModuleUpdate>,
) -> Result<StructureFile, CourseError> {
    use std::collections::HashSet;

    let existing = db::list_modules(conn, course_id)?;
    let existing_ids: HashSet<String> = existing.iter().map(|m| m.id.clone()).collect();
    let mut kept_ids: HashSet<String> = HashSet::new();

    let tx = conn.transaction()?;
    tx.execute("PRAGMA defer_foreign_keys = TRUE", [])?;

    let mut out_modules: Vec<ModuleNode> = Vec::with_capacity(incoming.len());
    for (mod_pos, m) in incoming.into_iter().enumerate() {
        let title = m.title.trim().to_string();
        if title.is_empty() {
            continue; // silently skip empty-title modules
        }
        let summary = m.summary.trim().to_string();
        let summary_db = if summary.is_empty() { None } else { Some(summary.as_str()) };

        let (mod_id, is_existing) = if !m.id.is_empty() && existing_ids.contains(&m.id) {
            (m.id.clone(), true)
        } else {
            (Uuid::new_v4().to_string(), false)
        };
        kept_ids.insert(mod_id.clone());

        if is_existing {
            db::update_module(&tx, &mod_id, None, mod_pos as i64, &title, summary_db)?;
        } else {
            db::insert_module(
                &tx,
                &mod_id,
                course_id,
                None,
                mod_pos as i64,
                &title,
                summary_db,
                "pending",
            )?;
        }

        let mut out_subs: Vec<ModuleNode> = Vec::with_capacity(m.submodules.len());
        for (sub_pos, s) in m.submodules.into_iter().enumerate() {
            let sub_title = s.title.trim().to_string();
            if sub_title.is_empty() {
                continue;
            }
            let sub_summary = s.summary.trim().to_string();
            let sub_summary_db = if sub_summary.is_empty() {
                None
            } else {
                Some(sub_summary.as_str())
            };

            let (sub_id, sub_is_existing) = if !s.id.is_empty() && existing_ids.contains(&s.id) {
                (s.id.clone(), true)
            } else {
                (Uuid::new_v4().to_string(), false)
            };
            kept_ids.insert(sub_id.clone());

            if sub_is_existing {
                db::update_module(
                    &tx,
                    &sub_id,
                    Some(&mod_id),
                    sub_pos as i64,
                    &sub_title,
                    sub_summary_db,
                )?;
            } else {
                db::insert_module(
                    &tx,
                    &sub_id,
                    course_id,
                    Some(&mod_id),
                    sub_pos as i64,
                    &sub_title,
                    sub_summary_db,
                    "pending",
                )?;
            }
            out_subs.push(ModuleNode {
                id: sub_id,
                title: sub_title,
                summary: sub_summary,
                submodules: vec![],
            });
        }
        out_modules.push(ModuleNode {
            id: mod_id,
            title,
            summary,
            submodules: out_subs,
        });
    }

    for id in existing_ids.difference(&kept_ids) {
        db::delete_module(&tx, id)?;
    }

    tx.commit()?;

    let file = StructureFile {
        course_id: course_id.to_string(),
        modules: out_modules,
    };
    let dir = paths.course_dir(course_id);
    fs::create_dir_all(&dir)?;
    let json = serde_json::to_string_pretty(&file).expect("serialize structure");
    fs::write(dir.join("structure.json"), json)?;

    db::set_course_status(conn, course_id, "ready", now_secs()?)?;
    Ok(file)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChatMessage {
    pub id: String,
    pub ts: i64,
    pub role: String, // "user" | "agent" | "system"
    pub text: String,
    #[serde(default)]
    pub modules: Vec<ModuleNode>,
}

fn chat_path(paths: &AppPaths, course_id: &str) -> PathBuf {
    paths.course_dir(course_id).join("structure_chat.jsonl")
}

pub fn read_chat(paths: &AppPaths, course_id: &str) -> Result<Vec<ChatMessage>, CourseError> {
    let path = chat_path(paths, course_id);
    if !path.exists() {
        return Ok(vec![]);
    }
    let content = fs::read_to_string(path)?;
    let mut out = Vec::new();
    for line in content.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let msg: ChatMessage = serde_json::from_str(line)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))?;
        out.push(msg);
    }
    Ok(out)
}

pub fn append_chat(
    paths: &AppPaths,
    course_id: &str,
    msg: &ChatMessage,
) -> Result<(), CourseError> {
    use std::io::Write;
    let dir = paths.course_dir(course_id);
    fs::create_dir_all(&dir)?;
    let path = chat_path(paths, course_id);
    let line = serde_json::to_string(msg).expect("serialize chat message");
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    writeln!(file, "{line}")?;
    Ok(())
}

pub fn read_memory_files(
    paths: &AppPaths,
    course_id: &str,
) -> Result<Vec<(String, String)>, CourseError> {
    let dir = paths.course_dir(course_id).join("memory");
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut entries: Vec<_> = fs::read_dir(&dir)?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("md"))
        .collect();
    entries.sort_by_key(|e| e.file_name());
    let mut out = Vec::new();
    for e in entries {
        let content = fs::read_to_string(e.path())?;
        out.push((e.file_name().to_string_lossy().to_string(), content));
    }
    Ok(out)
}

fn slugify(s: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for ch in s.chars() {
        let lower = ch.to_lowercase().next().unwrap_or(ch);
        if lower.is_alphanumeric() {
            out.push(lower);
            last_dash = false;
        } else if !last_dash && !out.is_empty() {
            out.push('-');
            last_dash = true;
        }
        if out.chars().count() >= 40 {
            break;
        }
    }
    out.trim_end_matches('-').to_string()
}

pub fn write_refinement_memory(
    paths: &AppPaths,
    course_id: &str,
    user_msg: &str,
    rationale: &str,
) -> Result<(), CourseError> {
    let dir = paths.course_dir(course_id).join("memory");
    fs::create_dir_all(&dir)?;
    let ts = now_secs()?;
    let slug = slugify(user_msg);
    let filename = if slug.is_empty() {
        format!("{ts}-refine.md")
    } else {
        format!("{ts}-refine-{slug}.md")
    };
    let content = format!(
        "---\nscope: course\ncreated_at: {ts}\ntrigger: \"Structure refinement\"\n---\n\n## Запрос пользователя\n{user_msg}\n\n## Принятые изменения\n{rationale}\n"
    );
    fs::write(dir.join(filename), content)?;
    Ok(())
}

/// Convert ModuleNode tree → ModuleUpdate list (fresh, no ids preserved).
pub fn tree_to_updates(modules: &[ModuleNode]) -> Vec<ModuleUpdate> {
    modules
        .iter()
        .map(|m| ModuleUpdate {
            id: String::new(),
            title: m.title.clone(),
            summary: m.summary.clone(),
            submodules: m
                .submodules
                .iter()
                .map(|s| ModuleUpdate {
                    id: String::new(),
                    title: s.title.clone(),
                    summary: s.summary.clone(),
                    submodules: vec![],
                })
                .collect(),
        })
        .collect()
}

pub fn load_structure(
    conn: &rusqlite::Connection,
    course_id: &str,
) -> Result<StructureFile, CourseError> {
    let rows = db::list_modules(conn, course_id)?;
    let mut top: Vec<ModuleNode> = Vec::new();
    let mut sub_by_parent: std::collections::HashMap<String, Vec<ModuleNode>> =
        std::collections::HashMap::new();

    for m in rows {
        let node = ModuleNode {
            id: m.id.clone(),
            title: m.title,
            summary: m.summary.unwrap_or_default(),
            submodules: vec![],
        };
        match m.parent_id {
            None => top.push(node),
            Some(parent) => sub_by_parent.entry(parent).or_default().push(node),
        }
    }
    for m in top.iter_mut() {
        if let Some(children) = sub_by_parent.remove(&m.id) {
            m.submodules = children;
        }
    }
    Ok(StructureFile {
        course_id: course_id.to_string(),
        modules: top,
    })
}

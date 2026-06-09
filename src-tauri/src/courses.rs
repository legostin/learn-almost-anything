use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::db;

pub struct AppPaths {
    pub courses_root: PathBuf,
    pub spaces_root: PathBuf,
}

impl AppPaths {
    pub fn course_dir(&self, course_id: &str) -> PathBuf {
        self.courses_root.join(course_id)
    }

    pub fn space_dir(&self, space_id: &str) -> PathBuf {
        self.spaces_root.join(space_id)
    }

    /// Where a space's converted-markdown / stored sources live.
    pub fn space_sources_dir(&self, space_id: &str) -> PathBuf {
        self.space_dir(space_id).join("sources")
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
    if let Some(title) = course.title.as_deref().filter(|s| !s.trim().is_empty()) {
        out.push_str(&format!("title: {}\n", title.trim()));
    }
    out.push_str(&format!("topic: {}\n", course.topic));
    out.push_str(&format!("language: {}\n", course.language));
    out.push_str(&format!("course_format: {}\n", course.course_format));
    out.push_str(&format!("created_at: {}\n", course.created_at));
    out.push_str("---\n\n");

    if let Some(title) = course.title.as_deref().filter(|s| !s.trim().is_empty()) {
        out.push_str("## Course title\n");
        out.push_str(title.trim());
        out.push_str("\n\n");
    }

    out.push_str("## Learning request\n");
    out.push_str(&course.topic);
    out.push_str("\n\n");

    out.push_str("## Generation format\n");
    out.push_str(&course.course_format);
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

/// Persist the running adaptive wizard interview so it survives an app restart.
/// Shape: { title, answered: [{question,answer}], current: <question|null>, done }.
pub fn write_wizard_dialog(
    paths: &AppPaths,
    course_id: &str,
    dialog: &serde_json::Value,
) -> Result<(), CourseError> {
    let dir = paths.course_dir(course_id);
    fs::create_dir_all(&dir)?;
    let json = serde_json::to_string_pretty(dialog).unwrap_or_else(|_| "{}".to_string());
    fs::write(dir.join("wizard_dialog.json"), json)?;
    Ok(())
}

pub fn read_wizard_dialog(
    paths: &AppPaths,
    course_id: &str,
) -> Result<serde_json::Value, CourseError> {
    let path = paths.course_dir(course_id).join("wizard_dialog.json");
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(serde_json::json!({}));
        }
        Err(e) => return Err(e.into()),
    };
    Ok(serde_json::from_str(&raw).unwrap_or_else(|_| serde_json::json!({})))
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
    #[serde(default)]
    pub prereqs: Vec<String>,
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
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    pub modules: Vec<SidecarModule>,
}

fn default_pending() -> String {
    "pending".to_string()
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModuleNode {
    pub id: String,
    pub title: String,
    pub summary: String,
    #[serde(default = "default_pending")]
    pub generation_state: String,
    #[serde(default)]
    pub test_passed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub test_passed_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub prereqs: Vec<String>,
    pub submodules: Vec<ModuleNode>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
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
    if let Some(title) = raw.title.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        db::set_course_title(conn, course_id, title, now_secs()?)?;
    }
    if let Some(category) = db::normalize_category(raw.category.as_deref()) {
        db::set_course_category(conn, course_id, &category)?;
    }

    // assign UUIDs in a single pass
    let modules: Vec<ModuleNode> = raw
        .modules
        .into_iter()
        .map(|m| ModuleNode {
            id: Uuid::new_v4().to_string(),
            title: m.title,
            summary: m.summary.unwrap_or_default(),
            generation_state: default_pending(),
            test_passed: false,
            test_passed_at: None,
            prereqs: vec![],
            submodules: m
                .submodules
                .into_iter()
                .map(|s| ModuleNode {
                    id: Uuid::new_v4().to_string(),
                    title: s.title,
                    summary: s.summary.unwrap_or_default(),
                    generation_state: default_pending(),
                    test_passed: false,
                    test_passed_at: None,
                    prereqs: s.prereqs,
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
            if !s.prereqs.is_empty() {
                let json = serde_json::to_string(&s.prereqs).unwrap_or_default();
                db::set_module_prereqs(conn, &s.id, Some(&json))?;
            }
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
    pub prereqs: Vec<String>,
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

            let sub_prereqs: Vec<String> = s
                .prereqs
                .iter()
                .map(|p| p.trim().to_string())
                .filter(|p| !p.is_empty())
                .collect();

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
            // Persist prereqs (clear when none, so an edit that removes them sticks).
            let prereqs_json = if sub_prereqs.is_empty() {
                None
            } else {
                Some(serde_json::to_string(&sub_prereqs).unwrap_or_default())
            };
            db::set_module_prereqs(&tx, &sub_id, prereqs_json.as_deref())?;
            out_subs.push(ModuleNode {
                id: sub_id,
                title: sub_title,
                summary: sub_summary,
                generation_state: default_pending(),
                test_passed: false,
                test_passed_at: None,
                prereqs: sub_prereqs,
                submodules: vec![],
            });
        }
        out_modules.push(ModuleNode {
            id: mod_id,
            title,
            summary,
            generation_state: default_pending(),
            test_passed: false,
            test_passed_at: None,
            prereqs: vec![],
            submodules: out_subs,
        });
    }

    // Delete removed nodes from the DB and collect their on-disk dirs so we don't
    // orphan generated content (article.md, widgets, images, …). Reordered/renamed
    // nodes keep their id and never land in this difference set. Resolve module vs
    // submodule via the pre-delete `existing` list (which carries parent_id).
    let mut dirs_to_remove: Vec<PathBuf> = Vec::new();
    for id in existing_ids.difference(&kept_ids) {
        db::delete_module(&tx, id)?;
        if let Some(m) = existing.iter().find(|m| &m.id == id) {
            let dir = match m.parent_id.as_deref() {
                Some(mod_id) => submodule_dir(paths, course_id, mod_id, id),
                None => paths.course_dir(course_id).join("modules").join(id),
            };
            dirs_to_remove.push(dir);
        }
    }

    tx.commit()?;

    // After the DB commit, drop the orphaned dirs (best-effort; a disk error here
    // must not fail the structure save the user already committed).
    for dir in dirs_to_remove {
        if dir.exists() {
            if let Err(e) = fs::remove_dir_all(&dir) {
                eprintln!(
                    "save_structure: failed to remove orphaned dir {}: {e}",
                    dir.display()
                );
            }
        }
    }

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

/// Persist a weak-spot diagnosis to course memory. One stable file per submodule
/// (overwritten on each new diagnosis) so the memory dir reflects the latest
/// struggle without piling up. Read back by `read_memory_files` into every draft,
/// so a targeted redraft (or any future generation) emphasizes these concepts.
pub fn write_weakspot_memory(
    paths: &AppPaths,
    course_id: &str,
    submodule_id: &str,
    submodule_title: &str,
    concepts: &[String],
) -> Result<(), CourseError> {
    let dir = paths.course_dir(course_id).join("memory");
    fs::create_dir_all(&dir)?;
    let ts = now_secs()?;
    let bullets = concepts
        .iter()
        .map(|c| format!("- {c}"))
        .collect::<Vec<_>>()
        .join("\n");
    let content = format!(
        "---\nscope: course\ncreated_at: {ts}\ntrigger: \"Weak-spot diagnosis\"\n---\n\n## Learner weak spots\nOn submodule \"{submodule_title}\", the learner answered these concepts incorrectly on the FIRST test attempt:\n{bullets}\n\nWhen (re)generating material that touches these concepts, give them more attention: add clearer worked examples, explicitly address the common misconception behind each, and add an active comprehension check. Write in the course language.\n"
    );
    fs::write(dir.join(format!("weakspot-{submodule_id}.md")), content)?;
    Ok(())
}

pub fn delete_course_dir(paths: &AppPaths, course_id: &str) -> Result<(), CourseError> {
    let dir = paths.course_dir(course_id);
    if dir.exists() {
        fs::remove_dir_all(&dir)?;
    }
    Ok(())
}

pub fn submodule_dir(paths: &AppPaths, course_id: &str, mod_id: &str, sub_id: &str) -> PathBuf {
    paths
        .course_dir(course_id)
        .join("modules")
        .join(mod_id)
        .join(sub_id)
}

pub fn write_submodule_article(
    paths: &AppPaths,
    course_id: &str,
    mod_id: &str,
    sub_id: &str,
    article: &str,
) -> Result<PathBuf, CourseError> {
    let dir = submodule_dir(paths, course_id, mod_id, sub_id);
    fs::create_dir_all(&dir)?;
    let path = dir.join("article.md");
    fs::write(&path, article)?;
    Ok(path)
}

pub fn write_submodule_widgets(
    paths: &AppPaths,
    course_id: &str,
    mod_id: &str,
    sub_id: &str,
    widgets: &serde_json::Value,
) -> Result<(), CourseError> {
    let dir = submodule_dir(paths, course_id, mod_id, sub_id);
    fs::create_dir_all(&dir)?;
    let json = serde_json::to_string_pretty(widgets).unwrap_or_else(|_| "{}".to_string());
    fs::write(dir.join("widgets.json"), json)?;
    Ok(())
}

pub fn write_submodule_sources(
    paths: &AppPaths,
    course_id: &str,
    mod_id: &str,
    sub_id: &str,
    sources: &serde_json::Value,
) -> Result<(), CourseError> {
    let arr = sources.as_array().map(|a| !a.is_empty()).unwrap_or(false);
    if !arr {
        return Ok(());
    }
    let dir = submodule_dir(paths, course_id, mod_id, sub_id);
    fs::create_dir_all(&dir)?;
    let json = serde_json::to_string_pretty(sources).unwrap_or_else(|_| "[]".to_string());
    fs::write(dir.join("sources.json"), json)?;
    Ok(())
}

pub fn write_submodule_test(
    paths: &AppPaths,
    course_id: &str,
    mod_id: &str,
    sub_id: &str,
    questions: &serde_json::Value,
) -> Result<(), CourseError> {
    let arr = questions.as_array().map(|a| !a.is_empty()).unwrap_or(false);
    if !arr {
        return Ok(());
    }
    let dir = submodule_dir(paths, course_id, mod_id, sub_id);
    fs::create_dir_all(&dir)?;
    let json = serde_json::to_string_pretty(questions).unwrap_or_else(|_| "[]".to_string());
    fs::write(dir.join("test.json"), json)?;
    Ok(())
}

pub fn write_submodule_review_notes(
    paths: &AppPaths,
    course_id: &str,
    mod_id: &str,
    sub_id: &str,
    notes: &str,
) -> Result<(), CourseError> {
    if notes.trim().is_empty() {
        return Ok(());
    }
    let dir = submodule_dir(paths, course_id, mod_id, sub_id);
    fs::create_dir_all(&dir)?;
    fs::write(dir.join("review_notes.md"), notes)?;
    Ok(())
}

/// Intermediate generation state, persisted after the expensive draft/review
/// stages so a failed run resumes instead of restarting from scratch.
/// `stage` is the last completed stage: "draft" or "review".
#[derive(Debug, Serialize, Deserialize)]
pub struct SubmoduleCheckpoint {
    pub stage: String,
    pub article: String,
    pub widgets: serde_json::Value,
    pub sources: serde_json::Value,
    pub notes: String,
}

pub fn write_submodule_checkpoint(
    paths: &AppPaths,
    course_id: &str,
    mod_id: &str,
    sub_id: &str,
    cp: &SubmoduleCheckpoint,
) -> Result<(), CourseError> {
    let dir = submodule_dir(paths, course_id, mod_id, sub_id);
    fs::create_dir_all(&dir)?;
    let json = serde_json::to_string_pretty(cp).unwrap_or_default();
    fs::write(dir.join("checkpoint.json"), json)?;
    Ok(())
}

pub fn read_submodule_checkpoint(
    paths: &AppPaths,
    course_id: &str,
    mod_id: &str,
    sub_id: &str,
) -> Option<SubmoduleCheckpoint> {
    let dir = submodule_dir(paths, course_id, mod_id, sub_id);
    let s = fs::read_to_string(dir.join("checkpoint.json")).ok()?;
    serde_json::from_str(&s).ok()
}

pub fn clear_submodule_checkpoint(paths: &AppPaths, course_id: &str, mod_id: &str, sub_id: &str) {
    let dir = submodule_dir(paths, course_id, mod_id, sub_id);
    let _ = fs::remove_file(dir.join("checkpoint.json"));
}

// Last generation error, persisted so the failed-state screen can show what
// happened even after the app is reopened (the live event is in-memory only).
pub fn write_submodule_error(
    paths: &AppPaths,
    course_id: &str,
    mod_id: &str,
    sub_id: &str,
    err: &str,
) -> Result<(), CourseError> {
    let dir = submodule_dir(paths, course_id, mod_id, sub_id);
    fs::create_dir_all(&dir)?;
    fs::write(dir.join("error.txt"), err)?;
    Ok(())
}

pub fn read_submodule_error(
    paths: &AppPaths,
    course_id: &str,
    mod_id: &str,
    sub_id: &str,
) -> Option<String> {
    let dir = submodule_dir(paths, course_id, mod_id, sub_id);
    fs::read_to_string(dir.join("error.txt"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

pub fn clear_submodule_error(paths: &AppPaths, course_id: &str, mod_id: &str, sub_id: &str) {
    let dir = submodule_dir(paths, course_id, mod_id, sub_id);
    let _ = fs::remove_file(dir.join("error.txt"));
}

// ── Homework assignments ────────────────────────────────────────────────────

pub fn assignment_dir(
    paths: &AppPaths,
    course_id: &str,
    mod_id: &str,
    sub_id: &str,
    assignment_id: &str,
) -> PathBuf {
    submodule_dir(paths, course_id, mod_id, sub_id)
        .join("assignments")
        .join(assignment_id)
}

pub fn write_submodule_flashcards(
    paths: &AppPaths,
    course_id: &str,
    mod_id: &str,
    sub_id: &str,
    flashcards: &serde_json::Value,
) -> Result<(), CourseError> {
    let has = flashcards.as_array().map(|a| !a.is_empty()).unwrap_or(false);
    if !has {
        return Ok(());
    }
    let dir = submodule_dir(paths, course_id, mod_id, sub_id);
    fs::create_dir_all(&dir)?;
    let json = serde_json::to_string_pretty(flashcards).unwrap_or_else(|_| "[]".to_string());
    fs::write(dir.join("flashcards.json"), json)?;
    Ok(())
}

pub fn write_submodule_assignments(
    paths: &AppPaths,
    course_id: &str,
    mod_id: &str,
    sub_id: &str,
    assignments: &serde_json::Value,
) -> Result<(), CourseError> {
    let has = assignments.as_array().map(|a| !a.is_empty()).unwrap_or(false);
    if !has {
        return Ok(());
    }
    let dir = submodule_dir(paths, course_id, mod_id, sub_id);
    fs::create_dir_all(&dir)?;
    let json = serde_json::to_string_pretty(assignments).unwrap_or_else(|_| "[]".to_string());
    fs::write(dir.join("assignments.json"), json)?;
    Ok(())
}

pub fn read_submodule_flashcards(
    paths: &AppPaths,
    course_id: &str,
    mod_id: &str,
    sub_id: &str,
) -> serde_json::Value {
    let dir = submodule_dir(paths, course_id, mod_id, sub_id);
    fs::read_to_string(dir.join("flashcards.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!([]))
}

pub fn read_submodule_assignments(
    paths: &AppPaths,
    course_id: &str,
    mod_id: &str,
    sub_id: &str,
) -> serde_json::Value {
    let dir = submodule_dir(paths, course_id, mod_id, sub_id);
    fs::read_to_string(dir.join("assignments.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!([]))
}

pub fn append_assignment_chat(
    paths: &AppPaths,
    course_id: &str,
    mod_id: &str,
    sub_id: &str,
    assignment_id: &str,
    turn: &serde_json::Value,
) -> Result<(), CourseError> {
    use std::io::Write;
    let dir = assignment_dir(paths, course_id, mod_id, sub_id, assignment_id);
    fs::create_dir_all(&dir)?;
    let line = serde_json::to_string(turn).unwrap_or_default();
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("chat.jsonl"))?;
    writeln!(file, "{line}")?;
    Ok(())
}

pub fn read_assignment_chat(
    paths: &AppPaths,
    course_id: &str,
    mod_id: &str,
    sub_id: &str,
    assignment_id: &str,
) -> Vec<serde_json::Value> {
    let path = assignment_dir(paths, course_id, mod_id, sub_id, assignment_id).join("chat.jsonl");
    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return vec![],
    };
    content
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

pub fn read_assignment_status(
    paths: &AppPaths,
    course_id: &str,
    mod_id: &str,
    sub_id: &str,
    assignment_id: &str,
) -> String {
    let path = assignment_dir(paths, course_id, mod_id, sub_id, assignment_id).join("state.json");
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("status").and_then(|x| x.as_str()).map(str::to_string))
        .unwrap_or_else(|| "pending".to_string())
}

pub fn write_assignment_status(
    paths: &AppPaths,
    course_id: &str,
    mod_id: &str,
    sub_id: &str,
    assignment_id: &str,
    status: &str,
    attempts: i64,
) -> Result<(), CourseError> {
    let dir = assignment_dir(paths, course_id, mod_id, sub_id, assignment_id);
    fs::create_dir_all(&dir)?;
    let json = serde_json::to_string_pretty(&serde_json::json!({
        "status": status,
        "attempts": attempts,
    }))
    .unwrap_or_default();
    fs::write(dir.join("state.json"), json)?;
    Ok(())
}

fn is_texty(name: &str) -> bool {
    let n = name.to_lowercase();
    const EXTS: &[&str] = &[
        ".rs", ".py", ".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs", ".java", ".kt", ".go", ".c",
        ".h", ".cpp", ".hpp", ".cc", ".cs", ".rb", ".php", ".swift", ".scala", ".sh", ".bash",
        ".sql", ".html", ".css", ".scss", ".vue", ".svelte", ".md", ".txt", ".json", ".yaml",
        ".yml", ".toml", ".xml", ".csv", ".ini", ".cfg", ".gradle",
    ];
    EXTS.iter().any(|e| n.ends_with(e)) || n.ends_with("readme") || n.contains("readme.")
}

fn extract_zip_text(path: &std::path::Path) -> Option<String> {
    use std::io::Read;
    let file = std::fs::File::open(path).ok()?;
    let mut zip = zip::ZipArchive::new(file).ok()?;
    let mut out = String::from("Archive contents:\n");
    for i in 0..zip.len() {
        if let Ok(f) = zip.by_index(i) {
            out.push_str("  ");
            out.push_str(f.name());
            out.push('\n');
        }
    }
    out.push('\n');
    let cap = 40_000usize;
    for i in 0..zip.len() {
        if out.len() >= cap {
            break;
        }
        let mut f = match zip.by_index(i) {
            Ok(f) => f,
            Err(_) => continue,
        };
        if f.is_dir() || !is_texty(f.name()) || f.size() > 200_000 {
            continue;
        }
        let name = f.name().to_string();
        let mut buf = Vec::new();
        if f.read_to_end(&mut buf).is_err() {
            continue;
        }
        if let Ok(s) = String::from_utf8(buf) {
            let remaining = cap.saturating_sub(out.len()).min(8_000);
            let body: String = s.chars().take(remaining).collect();
            out.push_str(&format!("\n----- {name} -----\n"));
            out.push_str(&body);
        }
    }
    Some(out)
}

/// Best-effort text extraction from a submitted file for agent review.
/// Returns text for UTF-8 text/code files and the text entries of .zip
/// archives; None for binary (image/pdf/docx) which is handled separately.
pub fn extract_submission_text(path: &std::path::Path) -> Option<String> {
    let lower = path.to_string_lossy().to_lowercase();
    if lower.ends_with(".zip") {
        return extract_zip_text(path);
    }
    let bytes = fs::read(path).ok()?;
    if bytes.is_empty() {
        return None;
    }
    match String::from_utf8(bytes) {
        Ok(s) => Some(s.chars().take(24_000).collect()),
        Err(_) => None,
    }
}

pub fn is_image_file(name: &str) -> bool {
    let n = name.to_lowercase();
    n.ends_with(".png")
        || n.ends_with(".jpg")
        || n.ends_with(".jpeg")
        || n.ends_with(".webp")
        || n.ends_with(".gif")
}

#[derive(Debug, Serialize)]
pub struct SubmoduleContent {
    pub article: String,
    pub widgets: serde_json::Value,
    pub sources: serde_json::Value,
    pub test: serde_json::Value,
    pub flashcards: serde_json::Value,
    pub review_notes: String,
}

pub fn read_submodule_content(
    paths: &AppPaths,
    course_id: &str,
    mod_id: &str,
    sub_id: &str,
) -> Result<SubmoduleContent, CourseError> {
    let dir = submodule_dir(paths, course_id, mod_id, sub_id);
    let article = fs::read_to_string(dir.join("article.md"))?;
    let widgets = fs::read_to_string(dir.join("widgets.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    let sources = fs::read_to_string(dir.join("sources.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!([]));
    let test = fs::read_to_string(dir.join("test.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!([]));
    let flashcards = fs::read_to_string(dir.join("flashcards.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!([]));
    let review_notes = fs::read_to_string(dir.join("review_notes.md")).unwrap_or_default();
    Ok(SubmoduleContent {
        article,
        widgets,
        sources,
        test,
        flashcards,
        review_notes,
    })
}

/// Collect previously-generated submodule articles in curriculum order,
/// stopping just before `until_sub_id`. Skips submodules whose article.md
/// is not on disk yet.
pub fn read_previous_articles(
    paths: &AppPaths,
    structure: &StructureFile,
    until_sub_id: &str,
) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    for m in &structure.modules {
        for s in &m.submodules {
            if s.id == until_sub_id {
                return out;
            }
            let path = submodule_dir(paths, &structure.course_id, &m.id, &s.id).join("article.md");
            if let Ok(article) = fs::read_to_string(&path) {
                out.push(serde_json::json!({
                    "moduleTitle": m.title,
                    "submoduleTitle": s.title,
                    "article": article,
                }));
            }
        }
    }
    out
}

/// Find a submodule's id and the id of its parent module within a tree.
pub fn find_submodule_path<'a>(
    file: &'a StructureFile,
    sub_id: &str,
) -> Option<(&'a ModuleNode, &'a ModuleNode)> {
    for m in &file.modules {
        for s in &m.submodules {
            if s.id == sub_id {
                return Some((m, s));
            }
        }
    }
    None
}

/// Convert ModuleNode tree → ModuleUpdate list (fresh, no ids preserved).
pub fn tree_to_updates(modules: &[ModuleNode]) -> Vec<ModuleUpdate> {
    modules
        .iter()
        .map(|m| ModuleUpdate {
            id: String::new(),
            title: m.title.clone(),
            summary: m.summary.clone(),
            prereqs: m.prereqs.clone(),
            submodules: m
                .submodules
                .iter()
                .map(|s| ModuleUpdate {
                    id: String::new(),
                    title: s.title.clone(),
                    summary: s.summary.clone(),
                    prereqs: s.prereqs.clone(),
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
    let passed = db::passed_submodules(conn, course_id)?;
    let mut top: Vec<ModuleNode> = Vec::new();
    let mut sub_by_parent: std::collections::HashMap<String, Vec<ModuleNode>> =
        std::collections::HashMap::new();

    for m in rows {
        let test_passed_at = passed.get(&m.id).copied();
        let prereqs = m
            .prereqs
            .as_deref()
            .and_then(|s| serde_json::from_str::<Vec<String>>(s).ok())
            .unwrap_or_default();
        let node = ModuleNode {
            test_passed: test_passed_at.is_some(),
            test_passed_at,
            id: m.id.clone(),
            title: m.title,
            summary: m.summary.unwrap_or_default(),
            generation_state: m.generation_state,
            prereqs,
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

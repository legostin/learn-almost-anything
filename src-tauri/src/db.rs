use std::path::Path;
use std::sync::Mutex;

use rusqlite::Connection;
use serde::Serialize;

mod embedded {
    refinery::embed_migrations!("./migrations");
}

#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    #[error(transparent)]
    Migration(#[from] refinery::Error),
}

pub struct Db(pub Mutex<Connection>);

pub fn open(path: &Path) -> Result<Db, DbError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let mut conn = Connection::open(path)?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    embedded::migrations::runner().run(&mut conn)?;
    Ok(Db(Mutex::new(conn)))
}

#[derive(Clone, Debug, Serialize)]
pub struct Course {
    pub id: String,
    pub topic: String,
    pub title: Option<String>,
    pub language: String,
    pub course_format: String,
    pub status: String,
    pub agent: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub catalog_origin_id: Option<String>,
    pub catalog_version: i64,
    pub catalog_synced_at: Option<i64>,
    pub space_id: Option<String>,
    pub strict_sources: Option<bool>,
    pub translated_from: Option<String>,
    pub category: Option<String>,
    /// Per-course generation profile (JSON), or None to use the global default.
    pub generation_profile: Option<serde_json::Value>,
}

pub const DEFAULT_COURSE_FORMAT: &str = "academic_course";

pub fn normalize_course_format(value: Option<&str>) -> &'static str {
    match value.map(str::trim) {
        Some("mini_module") => "mini_module",
        Some("podcast_series") => "podcast_series",
        Some("academic_course") | _ => DEFAULT_COURSE_FORMAT,
    }
}

const COURSE_COLS: &str = "id, topic, title, language, course_format, status, agent, created_at, updated_at, catalog_origin_id, catalog_version, catalog_synced_at, space_id, strict_sources, translated_from, category, generation_profile";

fn row_to_course(r: &rusqlite::Row) -> rusqlite::Result<Course> {
    Ok(Course {
        id: r.get(0)?,
        topic: r.get(1)?,
        title: r.get(2)?,
        language: r.get(3)?,
        course_format: r.get(4)?,
        status: r.get(5)?,
        agent: r.get(6)?,
        created_at: r.get(7)?,
        updated_at: r.get(8)?,
        catalog_origin_id: r.get(9)?,
        catalog_version: r.get(10)?,
        catalog_synced_at: r.get(11)?,
        space_id: r.get(12)?,
        strict_sources: r.get::<_, Option<i64>>(13)?.map(|v| v != 0),
        translated_from: r.get(14)?,
        category: r.get(15)?,
        generation_profile: r
            .get::<_, Option<String>>(16)?
            .and_then(|s| serde_json::from_str(&s).ok()),
    })
}

/// Insert a translated copy of `source` in `language`, linked via translated_from.
pub fn insert_translated_course(
    conn: &Connection,
    id: &str,
    source: &Course,
    language: &str,
    now: i64,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO courses \
         (id, topic, title, language, course_format, status, agent, created_at, updated_at, space_id, strict_sources, translated_from, category, generation_profile) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9, ?10, ?11, ?12, ?13)",
        rusqlite::params![
            id,
            source.topic,
            source.title,
            language,
            source.course_format,
            source.status,
            source.agent,
            now,
            source.space_id,
            source.strict_sources.map(|b| b as i64),
            source.id,
            source.category,
            source.generation_profile.as_ref().map(|v| v.to_string()),
        ],
    )?;
    Ok(())
}

/// Persist the per-course generation profile as a JSON string (or clear it).
pub fn set_course_generation_profile(
    conn: &Connection,
    id: &str,
    profile_json: Option<&str>,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE courses SET generation_profile = ?2 WHERE id = ?1",
        rusqlite::params![id, profile_json],
    )?;
    Ok(())
}

pub fn list_courses(conn: &Connection) -> Result<Vec<Course>, rusqlite::Error> {
    let sql = format!("SELECT {COURSE_COLS} FROM courses ORDER BY updated_at DESC");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], row_to_course)?;
    rows.collect()
}

pub fn insert_course(
    conn: &Connection,
    id: &str,
    topic: &str,
    language: &str,
    course_format: &str,
    agent: &str,
    now: i64,
    space_id: Option<&str>,
    strict_sources: Option<bool>,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO courses (id, topic, language, course_format, status, agent, created_at, updated_at, space_id, strict_sources) \
         VALUES (?1, ?2, ?3, ?4, 'wizard', ?5, ?6, ?6, ?7, ?8)",
        rusqlite::params![
            id,
            topic,
            language,
            normalize_course_format(Some(course_format)),
            agent,
            now,
            space_id,
            strict_sources.map(|b| b as i64),
        ],
    )?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub fn upsert_imported_course(
    conn: &Connection,
    id: &str,
    topic: &str,
    title: Option<&str>,
    language: &str,
    course_format: &str,
    agent: &str,
    status: &str,
    created_at: i64,
    updated_at: i64,
    catalog_origin_id: &str,
    catalog_version: i64,
    catalog_synced_at: i64,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO courses \
         (id, topic, title, language, course_format, status, agent, created_at, updated_at, catalog_origin_id, catalog_version, catalog_synced_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12) \
         ON CONFLICT(id) DO UPDATE SET \
           topic = excluded.topic, \
           title = excluded.title, \
           language = excluded.language, \
           course_format = excluded.course_format, \
           status = excluded.status, \
           agent = excluded.agent, \
           updated_at = excluded.updated_at, \
           catalog_origin_id = excluded.catalog_origin_id, \
           catalog_version = excluded.catalog_version, \
           catalog_synced_at = excluded.catalog_synced_at",
        rusqlite::params![
            id,
            topic,
            title,
            language,
            normalize_course_format(Some(course_format)),
            status,
            agent,
            created_at,
            updated_at,
            catalog_origin_id,
            catalog_version,
            catalog_synced_at
        ],
    )?;
    Ok(())
}

pub fn get_course(conn: &Connection, id: &str) -> Result<Option<Course>, rusqlite::Error> {
    let sql = format!("SELECT {COURSE_COLS} FROM courses WHERE id = ?1");
    conn.query_row(&sql, [id], row_to_course)
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })
}

pub fn get_course_by_catalog_origin(
    conn: &Connection,
    catalog_origin_id: &str,
) -> Result<Option<Course>, rusqlite::Error> {
    let sql = format!("SELECT {COURSE_COLS} FROM courses WHERE catalog_origin_id = ?1");
    conn.query_row(&sql, [catalog_origin_id], row_to_course)
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })
}

pub fn find_catalog_duplicate_candidate(
    conn: &Connection,
    topic: &str,
    title: Option<&str>,
    language: &str,
) -> Result<Option<Course>, rusqlite::Error> {
    let Some(title) = title.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    let sql = format!(
        "SELECT {COURSE_COLS} FROM courses \
         WHERE catalog_origin_id IS NULL \
           AND topic = ?1 \
           AND COALESCE(title, '') = ?2 \
           AND language = ?3 \
         ORDER BY updated_at DESC \
         LIMIT 1"
    );
    conn.query_row(&sql, rusqlite::params![topic, title, language], row_to_course)
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })
}

pub fn set_course_status(
    conn: &Connection,
    id: &str,
    status: &str,
    now: i64,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE courses SET status = ?2, updated_at = ?3 WHERE id = ?1",
        rusqlite::params![id, status, now],
    )?;
    Ok(())
}

pub fn set_course_agent(
    conn: &Connection,
    id: &str,
    agent: &str,
    now: i64,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE courses SET agent = ?2, updated_at = ?3 WHERE id = ?1",
        rusqlite::params![id, agent, now],
    )?;
    Ok(())
}

pub fn set_course_title(
    conn: &Connection,
    id: &str,
    title: &str,
    now: i64,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE courses SET title = ?2, updated_at = ?3 WHERE id = ?1",
        rusqlite::params![id, title, now],
    )?;
    Ok(())
}

/// Valid course category ids. Keep in sync with sidecar/src/lib/categories.mjs
/// (CATEGORY_IDS) and src/App.tsx (CATEGORY_LABELS).
pub const CATEGORY_IDS: &[&str] = &[
    "programming",
    "data_ai",
    "science_math",
    "engineering",
    "business",
    "humanities",
    "social_science",
    "arts_design",
    "music",
    "language",
    "health",
    "lifestyle",
    "general",
];

/// Lowercase/trim a value to a valid category id, or None.
pub fn normalize_category(value: Option<&str>) -> Option<String> {
    let v = value?.trim().to_lowercase();
    CATEGORY_IDS.contains(&v.as_str()).then_some(v)
}

pub fn set_course_category(
    conn: &Connection,
    id: &str,
    category: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE courses SET category = ?2 WHERE id = ?1",
        rusqlite::params![id, category],
    )?;
    Ok(())
}

pub fn touch_course(conn: &Connection, id: &str, now: i64) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE courses SET updated_at = ?2 WHERE id = ?1",
        rusqlite::params![id, now],
    )?;
    Ok(())
}

pub fn set_course_catalog_sync(
    conn: &Connection,
    id: &str,
    catalog_origin_id: &str,
    catalog_version: i64,
    now: i64,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE courses \
         SET catalog_origin_id = ?2, catalog_version = ?3, catalog_synced_at = ?4 \
         WHERE id = ?1",
        rusqlite::params![id, catalog_origin_id, catalog_version, now],
    )?;
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct Module {
    pub id: String,
    pub course_id: String,
    pub parent_id: Option<String>,
    pub position: i64,
    pub title: String,
    pub summary: Option<String>,
    pub generation_state: String,
}

pub fn insert_module(
    conn: &Connection,
    id: &str,
    course_id: &str,
    parent_id: Option<&str>,
    position: i64,
    title: &str,
    summary: Option<&str>,
    generation_state: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO modules (id, course_id, parent_id, position, title, summary, generation_state) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![id, course_id, parent_id, position, title, summary, generation_state],
    )?;
    Ok(())
}

pub fn list_modules(conn: &Connection, course_id: &str) -> Result<Vec<Module>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, course_id, parent_id, position, title, summary, generation_state \
         FROM modules WHERE course_id = ?1 ORDER BY parent_id IS NULL DESC, position",
    )?;
    let rows = stmt.query_map([course_id], |r| {
        Ok(Module {
            id: r.get(0)?,
            course_id: r.get(1)?,
            parent_id: r.get(2)?,
            position: r.get(3)?,
            title: r.get(4)?,
            summary: r.get(5)?,
            generation_state: r.get(6)?,
        })
    })?;
    rows.collect()
}

pub fn delete_modules_for_course(
    conn: &Connection,
    course_id: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute("DELETE FROM modules WHERE course_id = ?1", [course_id])?;
    Ok(())
}

/// Update just a module's title + summary (used by translation).
pub fn update_module_text(
    conn: &Connection,
    id: &str,
    title: &str,
    summary: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE modules SET title = ?2, summary = ?3 WHERE id = ?1",
        rusqlite::params![id, title, if summary.is_empty() { None } else { Some(summary) }],
    )?;
    Ok(())
}

pub fn update_module(
    conn: &Connection,
    id: &str,
    parent_id: Option<&str>,
    position: i64,
    title: &str,
    summary: Option<&str>,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE modules SET parent_id = ?2, position = ?3, title = ?4, summary = ?5 \
         WHERE id = ?1",
        rusqlite::params![id, parent_id, position, title, summary],
    )?;
    Ok(())
}

pub fn delete_module(conn: &Connection, id: &str) -> Result<(), rusqlite::Error> {
    conn.execute("DELETE FROM modules WHERE id = ?1", [id])?;
    Ok(())
}

pub fn set_module_generation_state(
    conn: &Connection,
    id: &str,
    state: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE modules SET generation_state = ?2 WHERE id = ?1",
        rusqlite::params![id, state],
    )?;
    Ok(())
}

pub fn queue_pending_submodules(
    conn: &Connection,
    course_id: &str,
) -> Result<usize, rusqlite::Error> {
    conn.execute(
        "UPDATE modules \
         SET generation_state = 'queued' \
         WHERE course_id = ?1 \
           AND parent_id IS NOT NULL \
           AND generation_state = 'pending'",
        [course_id],
    )
}

/// Reset any submodules left in 'generating' state from a previous app run.
/// They couldn't possibly still be running — the worker threads died with
/// the previous process. Mark them 'failed' so the user can retry.
pub fn reset_stuck_generations(conn: &Connection) -> Result<usize, rusqlite::Error> {
    conn.execute(
        "UPDATE modules SET generation_state = 'failed' WHERE generation_state = 'generating'",
        [],
    )
}

pub fn delete_course(conn: &Connection, id: &str) -> Result<(), rusqlite::Error> {
    // modules + progress cascade via foreign keys; jobs are course-scoped
    // but not foreign-keyed (course_id stored as plain TEXT) so we sweep
    // them explicitly.
    conn.execute("DELETE FROM jobs WHERE course_id = ?1", [id])?;
    conn.execute("DELETE FROM courses WHERE id = ?1", [id])?;
    Ok(())
}

pub fn get_module_generation_state(
    conn: &Connection,
    id: &str,
) -> Result<Option<String>, rusqlite::Error> {
    conn.query_row(
        "SELECT generation_state FROM modules WHERE id = ?1",
        [id],
        |r| r.get::<_, String>(0),
    )
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(other),
    })
}

pub fn set_test_passed(conn: &Connection, module_id: &str, now: i64) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO progress (module_id, test_passed_at) VALUES (?1, ?2) \
         ON CONFLICT(module_id) DO UPDATE SET test_passed_at = ?2",
        rusqlite::params![module_id, now],
    )?;
    Ok(())
}

/// Record one graded test attempt. Increments the attempt count and stores the
/// FIRST attempt's ratio + per-question correctness (COALESCE keeps the first),
/// so spaced-repetition scheduling grades from honest first-attempt performance
/// rather than a retake-until-pass result.
pub fn record_test_attempt(
    conn: &Connection,
    module_id: &str,
    ratio: f64,
    results: &[bool],
    now: i64,
) -> Result<(), rusqlite::Error> {
    let results_json = serde_json::to_string(results).unwrap_or_else(|_| "[]".to_string());
    conn.execute(
        "INSERT INTO progress (module_id, attempts, first_attempt_ratio, first_attempt_results, first_attempt_at) \
         VALUES (?1, 1, ?2, ?3, ?4) \
         ON CONFLICT(module_id) DO UPDATE SET \
            attempts = attempts + 1, \
            first_attempt_ratio = COALESCE(first_attempt_ratio, ?2), \
            first_attempt_results = COALESCE(first_attempt_results, ?3), \
            first_attempt_at = COALESCE(first_attempt_at, ?4)",
        rusqlite::params![module_id, ratio, results_json, now],
    )?;
    Ok(())
}

pub fn passed_submodules(
    conn: &Connection,
    course_id: &str,
) -> Result<std::collections::HashMap<String, i64>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT p.module_id, p.test_passed_at FROM progress p \
         JOIN modules m ON m.id = p.module_id \
         WHERE m.course_id = ?1 AND p.test_passed_at IS NOT NULL",
    )?;
    let rows = stmt.query_map([course_id], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
    })?;
    rows.collect()
}

/// (module_id, submodule_id) of the first submodule in 'pending' state, ordered
/// by parent position then submodule position. None if everything is generated
/// or generating.
pub fn first_pending_submodule(
    conn: &Connection,
    course_id: &str,
) -> Result<Option<(String, String)>, rusqlite::Error> {
    conn.query_row(
        "SELECT m.parent_id, m.id FROM modules m \
         JOIN modules p ON p.id = m.parent_id \
         WHERE m.course_id = ?1 \
           AND m.parent_id IS NOT NULL \
           AND m.generation_state = 'pending' \
         ORDER BY p.position, m.position \
         LIMIT 1",
        [course_id],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
    )
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(other),
    })
}

/// (module_id, submodule_id) of the first queued submodule in plan order.
pub fn first_queued_submodule(
    conn: &Connection,
    course_id: &str,
) -> Result<Option<(String, String)>, rusqlite::Error> {
    conn.query_row(
        "SELECT m.parent_id, m.id FROM modules m \
         JOIN modules p ON p.id = m.parent_id \
         WHERE m.course_id = ?1 \
           AND m.parent_id IS NOT NULL \
           AND m.generation_state = 'queued' \
         ORDER BY p.position, m.position \
         LIMIT 1",
        [course_id],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
    )
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(other),
    })
}

pub fn has_generating_submodule(
    conn: &Connection,
    course_id: &str,
) -> Result<bool, rusqlite::Error> {
    conn.query_row(
        "SELECT EXISTS( \
             SELECT 1 FROM modules \
             WHERE course_id = ?1 \
               AND parent_id IS NOT NULL \
               AND generation_state = 'generating' \
         )",
        [course_id],
        |r| r.get::<_, i64>(0),
    )
    .map(|v| v != 0)
}

// ===== Spaces =====

#[derive(Clone, Debug, Serialize)]
pub struct Space {
    pub id: String,
    pub name: String,
    pub description: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub strict: bool,
    pub source_count: i64,
}

#[derive(Clone, Debug, Serialize)]
pub struct SpaceSource {
    pub id: String,
    pub space_id: String,
    pub kind: String,
    pub title: String,
    pub r#ref: String,
    pub status: String,
    pub md_path: Option<String>,
    pub error: Option<String>,
    pub created_at: i64,
}

const SPACE_SELECT: &str = "SELECT s.id, s.name, s.description, s.created_at, s.updated_at, \
    s.strict_sources, \
    (SELECT COUNT(*) FROM space_sources ss WHERE ss.space_id = s.id) FROM spaces s";

fn row_to_space(r: &rusqlite::Row) -> rusqlite::Result<Space> {
    Ok(Space {
        id: r.get(0)?,
        name: r.get(1)?,
        description: r.get(2)?,
        created_at: r.get(3)?,
        updated_at: r.get(4)?,
        strict: r.get::<_, i64>(5)? != 0,
        source_count: r.get(6)?,
    })
}

pub fn list_spaces(conn: &Connection) -> Result<Vec<Space>, rusqlite::Error> {
    let sql = format!("{SPACE_SELECT} ORDER BY s.updated_at DESC");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], row_to_space)?;
    rows.collect()
}

pub fn get_space(conn: &Connection, id: &str) -> Result<Option<Space>, rusqlite::Error> {
    let sql = format!("{SPACE_SELECT} WHERE s.id = ?1");
    conn.query_row(&sql, [id], row_to_space)
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })
}

pub fn insert_space(
    conn: &Connection,
    id: &str,
    name: &str,
    description: &str,
    now: i64,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO spaces (id, name, description, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
        rusqlite::params![id, name, description, now],
    )?;
    Ok(())
}

pub fn touch_space(conn: &Connection, id: &str, now: i64) -> Result<(), rusqlite::Error> {
    conn.execute("UPDATE spaces SET updated_at = ?2 WHERE id = ?1", rusqlite::params![id, now])?;
    Ok(())
}

pub fn set_space_strict(
    conn: &Connection,
    id: &str,
    strict: bool,
    now: i64,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE spaces SET strict_sources = ?2, updated_at = ?3 WHERE id = ?1",
        rusqlite::params![id, strict as i64, now],
    )?;
    Ok(())
}

pub fn delete_space(conn: &Connection, id: &str) -> Result<(), rusqlite::Error> {
    conn.execute("DELETE FROM spaces WHERE id = ?1", [id])?;
    Ok(())
}

const SOURCE_COLS: &str =
    "id, space_id, kind, title, ref, status, md_path, error, created_at";

fn row_to_source(r: &rusqlite::Row) -> rusqlite::Result<SpaceSource> {
    Ok(SpaceSource {
        id: r.get(0)?,
        space_id: r.get(1)?,
        kind: r.get(2)?,
        title: r.get(3)?,
        r#ref: r.get(4)?,
        status: r.get(5)?,
        md_path: r.get(6)?,
        error: r.get(7)?,
        created_at: r.get(8)?,
    })
}

pub fn list_space_sources(
    conn: &Connection,
    space_id: &str,
) -> Result<Vec<SpaceSource>, rusqlite::Error> {
    let sql = format!("SELECT {SOURCE_COLS} FROM space_sources WHERE space_id = ?1 ORDER BY created_at ASC");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([space_id], row_to_source)?;
    rows.collect()
}

pub fn get_space_source(
    conn: &Connection,
    id: &str,
) -> Result<Option<SpaceSource>, rusqlite::Error> {
    let sql = format!("SELECT {SOURCE_COLS} FROM space_sources WHERE id = ?1");
    conn.query_row(&sql, [id], row_to_source)
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })
}

#[allow(clippy::too_many_arguments)]
pub fn insert_space_source(
    conn: &Connection,
    id: &str,
    space_id: &str,
    kind: &str,
    title: &str,
    reference: &str,
    status: &str,
    md_path: Option<&str>,
    now: i64,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO space_sources (id, space_id, kind, title, ref, status, md_path, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![id, space_id, kind, title, reference, status, md_path, now],
    )?;
    Ok(())
}

pub fn set_space_source_status(
    conn: &Connection,
    id: &str,
    status: &str,
    md_path: Option<&str>,
    error: Option<&str>,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE space_sources SET status = ?2, md_path = ?3, error = ?4 WHERE id = ?1",
        rusqlite::params![id, status, md_path, error],
    )?;
    Ok(())
}

pub fn delete_space_source(conn: &Connection, id: &str) -> Result<(), rusqlite::Error> {
    conn.execute("DELETE FROM space_sources WHERE id = ?1", [id])?;
    Ok(())
}

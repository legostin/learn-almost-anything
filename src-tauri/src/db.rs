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

#[derive(Debug, Serialize)]
pub struct Course {
    pub id: String,
    pub topic: String,
    pub title: Option<String>,
    pub language: String,
    pub status: String,
    pub agent: String,
    pub created_at: i64,
    pub updated_at: i64,
}

const COURSE_COLS: &str = "id, topic, title, language, status, agent, created_at, updated_at";

fn row_to_course(r: &rusqlite::Row) -> rusqlite::Result<Course> {
    Ok(Course {
        id: r.get(0)?,
        topic: r.get(1)?,
        title: r.get(2)?,
        language: r.get(3)?,
        status: r.get(4)?,
        agent: r.get(5)?,
        created_at: r.get(6)?,
        updated_at: r.get(7)?,
    })
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
    agent: &str,
    now: i64,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO courses (id, topic, language, status, agent, created_at, updated_at) \
         VALUES (?1, ?2, ?3, 'wizard', ?4, ?5, ?5)",
        rusqlite::params![id, topic, language, agent, now],
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

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
    pub language: String,
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
}

pub fn list_courses(conn: &Connection) -> Result<Vec<Course>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, topic, language, status, created_at, updated_at \
         FROM courses ORDER BY updated_at DESC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(Course {
            id: r.get(0)?,
            topic: r.get(1)?,
            language: r.get(2)?,
            status: r.get(3)?,
            created_at: r.get(4)?,
            updated_at: r.get(5)?,
        })
    })?;
    rows.collect()
}

pub fn insert_course(
    conn: &Connection,
    id: &str,
    topic: &str,
    language: &str,
    now: i64,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO courses (id, topic, language, status, created_at, updated_at) \
         VALUES (?1, ?2, ?3, 'wizard', ?4, ?4)",
        rusqlite::params![id, topic, language, now],
    )?;
    Ok(())
}

pub fn get_course(conn: &Connection, id: &str) -> Result<Option<Course>, rusqlite::Error> {
    conn.query_row(
        "SELECT id, topic, language, status, created_at, updated_at FROM courses WHERE id = ?1",
        [id],
        |r| {
            Ok(Course {
                id: r.get(0)?,
                topic: r.get(1)?,
                language: r.get(2)?,
                status: r.get(3)?,
                created_at: r.get(4)?,
                updated_at: r.get(5)?,
            })
        },
    )
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

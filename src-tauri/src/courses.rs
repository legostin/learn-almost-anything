use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

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

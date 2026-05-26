use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::Manager;
use uuid::Uuid;

mod courses;
mod db;
mod sidecar;

use courses::{AppPaths, QnA};
use db::{Course, Db};
use sidecar::Sidecar;

#[tauri::command]
fn list_courses(state: tauri::State<'_, Db>) -> Result<Vec<Course>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db::list_courses(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_course(
    state: tauri::State<'_, Db>,
    topic: String,
    language: String,
) -> Result<String, String> {
    let id = Uuid::new_v4().to_string();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs() as i64;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db::insert_course(&conn, &id, &topic, &language, now).map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
fn sidecar_call(
    state: tauri::State<'_, Sidecar>,
    method: String,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    state
        .call(&method, params, Duration::from_secs(180))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn save_wizard_answers(
    db_state: tauri::State<'_, Db>,
    paths: tauri::State<'_, AppPaths>,
    course_id: String,
    answers: Vec<QnA>,
) -> Result<(), String> {
    let conn = db_state.0.lock().map_err(|e| e.to_string())?;
    courses::save_wizard_answers(&conn, &paths, &course_id, &answers).map_err(|e| e.to_string())
}

#[tauri::command]
fn build_structure(
    db_state: tauri::State<'_, Db>,
    paths: tauri::State<'_, AppPaths>,
    sidecar_state: tauri::State<'_, Sidecar>,
    course_id: String,
) -> Result<courses::StructureFile, String> {
    let course = {
        let conn = db_state.0.lock().map_err(|e| e.to_string())?;
        db::get_course(&conn, &course_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("course not found: {course_id}"))?
    };
    let course_md = courses::read_course_md(&paths, &course_id).map_err(|e| e.to_string())?;

    let params = serde_json::json!({
        "topic": course.topic,
        "language": course.language,
        "courseMd": course_md,
    });
    let result = sidecar_state
        .call("build_structure", params, Duration::from_secs(300))
        .map_err(|e| e.to_string())?;
    let raw: courses::SidecarTree = serde_json::from_value(result).map_err(|e| e.to_string())?;

    let conn = db_state.0.lock().map_err(|e| e.to_string())?;
    courses::install_structure(&conn, &paths, &course_id, raw).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_structure(
    db_state: tauri::State<'_, Db>,
    course_id: String,
) -> Result<courses::StructureFile, String> {
    let conn = db_state.0.lock().map_err(|e| e.to_string())?;
    courses::load_structure(&conn, &course_id).map_err(|e| e.to_string())
}

fn sidecar_script_path() -> PathBuf {
    // In dev: src-tauri/ is CARGO_MANIFEST_DIR; sidecar/ is its sibling.
    // TODO(prod): switch to app.path().resource_dir() once we bundle the sidecar.
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri has a parent")
        .join("sidecar")
        .join("src")
        .join("index.mjs")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            let db_path = dir.join("learn-anything.db");
            let db = db::open(&db_path).map_err(|e| {
                Box::<dyn std::error::Error>::from(format!("db init failed: {e}"))
            })?;
            app.manage(db);

            app.manage(AppPaths {
                courses_root: dir.join("courses"),
            });

            let sidecar = Sidecar::spawn(&sidecar_script_path()).map_err(|e| {
                Box::<dyn std::error::Error>::from(format!("sidecar spawn failed: {e}"))
            })?;
            app.manage(sidecar);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_courses,
            create_course,
            sidecar_call,
            save_wizard_answers,
            build_structure,
            get_structure
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

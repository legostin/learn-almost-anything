use std::path::PathBuf;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

mod courses;
mod db;
mod sidecar;

use courses::{AppPaths, QnA};
use db::{Course, Db};
use sidecar::Sidecar;

const JOB_EVENT: &str = "agent_job";
const STAGE_EVENT: &str = "agent_stage";

#[tauri::command]
fn list_courses(state: tauri::State<'_, Arc<Db>>) -> Result<Vec<Course>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db::list_courses(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_course(
    state: tauri::State<'_, Arc<Db>>,
    topic: String,
    language: String,
    agent: Option<String>,
) -> Result<String, String> {
    let agent = agent.unwrap_or_else(|| "claude".to_string());
    if agent != "claude" && agent != "codex" {
        return Err(format!("unknown agent: {agent}"));
    }
    let id = Uuid::new_v4().to_string();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs() as i64;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db::insert_course(&conn, &id, &topic, &language, &agent, now).map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
fn sidecar_call(
    state: tauri::State<'_, Arc<Sidecar>>,
    method: String,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    state
        .call(&method, params, Duration::from_secs(180))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn save_wizard_answers(
    db_state: tauri::State<'_, Arc<Db>>,
    paths: tauri::State<'_, Arc<AppPaths>>,
    course_id: String,
    answers: Vec<QnA>,
) -> Result<(), String> {
    let conn = db_state.0.lock().map_err(|e| e.to_string())?;
    courses::save_wizard_answers(&conn, &paths, &course_id, &answers).map_err(|e| e.to_string())
}

fn emit_stage_event(app: &AppHandle, course_id: &str, submodule_id: &str, stage: &str) {
    let _ = app.emit(
        STAGE_EVENT,
        json!({
            "courseId": course_id,
            "submoduleId": submodule_id,
            "stage": stage,
        }),
    );
}

fn emit_job_event(app: &AppHandle, course_id: &str, kind: &str, payload: serde_json::Value) {
    let mut event = json!({
        "courseId": course_id,
        "kind": kind,
    });
    if let serde_json::Value::Object(map) = payload {
        for (k, v) in map {
            event[k] = v;
        }
    }
    let _ = app.emit(JOB_EVENT, event);
}

#[tauri::command]
fn start_wizard_questions(
    app: AppHandle,
    db_state: tauri::State<'_, Arc<Db>>,
    sidecar_state: tauri::State<'_, Arc<Sidecar>>,
    course_id: String,
) -> Result<(), String> {
    let course = {
        let conn = db_state.0.lock().map_err(|e| e.to_string())?;
        db::get_course(&conn, &course_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("course not found: {course_id}"))?
    };
    let sidecar = sidecar_state.inner().clone();
    let app2 = app.clone();
    let cid = course_id.clone();

    thread::spawn(move || {
        let params = json!({
            "backend": course.agent,
            "topic": course.topic,
            "language": course.language,
        });
        let payload = match sidecar.call("wizard_questions", params, Duration::from_secs(300)) {
            Ok(v) => json!({ "ok": true, "result": v }),
            Err(e) => json!({ "ok": false, "error": e.to_string() }),
        };
        emit_job_event(&app2, &cid, "wizard_questions", payload);
    });
    Ok(())
}

#[tauri::command]
fn start_build_structure(
    app: AppHandle,
    db_state: tauri::State<'_, Arc<Db>>,
    paths_state: tauri::State<'_, Arc<AppPaths>>,
    sidecar_state: tauri::State<'_, Arc<Sidecar>>,
    course_id: String,
) -> Result<(), String> {
    let course = {
        let conn = db_state.0.lock().map_err(|e| e.to_string())?;
        db::get_course(&conn, &course_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("course not found: {course_id}"))?
    };
    let course_md = courses::read_course_md(&paths_state, &course_id).map_err(|e| e.to_string())?;

    let db = db_state.inner().clone();
    let paths = paths_state.inner().clone();
    let sidecar = sidecar_state.inner().clone();
    let app2 = app.clone();
    let cid = course_id.clone();

    thread::spawn(move || {
        let params = json!({
            "backend": course.agent,
            "topic": course.topic,
            "language": course.language,
            "courseMd": course_md,
        });
        let payload = match sidecar.call("build_structure", params, Duration::from_secs(420)) {
            Ok(v) => match serde_json::from_value::<courses::SidecarTree>(v) {
                Ok(raw) => {
                    let conn = match db.0.lock() {
                        Ok(c) => c,
                        Err(e) => {
                            emit_job_event(
                                &app2,
                                &cid,
                                "build_structure",
                                json!({ "ok": false, "error": e.to_string() }),
                            );
                            return;
                        }
                    };
                    match courses::install_structure(&conn, &paths, &cid, raw) {
                        Ok(_) => json!({ "ok": true }),
                        Err(e) => json!({ "ok": false, "error": e.to_string() }),
                    }
                }
                Err(e) => json!({ "ok": false, "error": format!("sidecar payload: {e}") }),
            },
            Err(e) => json!({ "ok": false, "error": e.to_string() }),
        };
        emit_job_event(&app2, &cid, "build_structure", payload);
    });
    Ok(())
}

#[tauri::command]
fn get_structure(
    db_state: tauri::State<'_, Arc<Db>>,
    course_id: String,
) -> Result<courses::StructureFile, String> {
    let conn = db_state.0.lock().map_err(|e| e.to_string())?;
    courses::load_structure(&conn, &course_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_structure(
    db_state: tauri::State<'_, Arc<Db>>,
    paths: tauri::State<'_, Arc<AppPaths>>,
    course_id: String,
    modules: Vec<courses::ModuleUpdate>,
) -> Result<courses::StructureFile, String> {
    let mut conn = db_state.0.lock().map_err(|e| e.to_string())?;
    courses::save_structure(&mut conn, &paths, &course_id, modules).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_chat(
    paths: tauri::State<'_, Arc<AppPaths>>,
    course_id: String,
) -> Result<Vec<courses::ChatMessage>, String> {
    courses::read_chat(&paths, &course_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn start_structure_refine(
    app: AppHandle,
    db_state: tauri::State<'_, Arc<Db>>,
    paths_state: tauri::State<'_, Arc<AppPaths>>,
    sidecar_state: tauri::State<'_, Arc<Sidecar>>,
    course_id: String,
    user_message: String,
) -> Result<(), String> {
    let text = user_message.trim().to_string();
    if text.is_empty() {
        return Err("message must be non-empty".to_string());
    }
    let course = {
        let conn = db_state.0.lock().map_err(|e| e.to_string())?;
        db::get_course(&conn, &course_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("course not found: {course_id}"))?
    };
    let course_md = courses::read_course_md(&paths_state, &course_id).map_err(|e| e.to_string())?;
    let current_structure = {
        let conn = db_state.0.lock().map_err(|e| e.to_string())?;
        courses::load_structure(&conn, &course_id).map_err(|e| e.to_string())?
    };
    let memory_files = courses::read_memory_files(&paths_state, &course_id)
        .map_err(|e| e.to_string())?;
    let prior_chat = courses::read_chat(&paths_state, &course_id).map_err(|e| e.to_string())?;

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs() as i64;
    let user_msg = courses::ChatMessage {
        id: Uuid::new_v4().to_string(),
        ts: now,
        role: "user".to_string(),
        text: text.clone(),
        modules: vec![],
    };
    courses::append_chat(&paths_state, &course_id, &user_msg).map_err(|e| e.to_string())?;

    let chat_for_prompt: Vec<serde_json::Value> = prior_chat
        .iter()
        .filter(|m| m.role == "user" || m.role == "agent")
        .map(|m| json!({ "role": m.role, "text": m.text }))
        .collect();
    let memory_for_prompt: Vec<serde_json::Value> = memory_files
        .iter()
        .map(|(name, content)| json!({ "filename": name, "content": content }))
        .collect();

    let paths = paths_state.inner().clone();
    let sidecar = sidecar_state.inner().clone();
    let app2 = app.clone();
    let cid = course_id.clone();

    thread::spawn(move || {
        let params = json!({
            "backend": course.agent,
            "topic": course.topic,
            "language": course.language,
            "courseMd": course_md,
            "currentStructure": current_structure,
            "memoryFiles": memory_for_prompt,
            "chatHistory": chat_for_prompt,
            "userMessage": text,
        });
        let payload = match sidecar.call("refine_structure", params, Duration::from_secs(300)) {
            Ok(v) => match parse_refine(v) {
                Ok((reply, modules)) => {
                    let agent_msg = courses::ChatMessage {
                        id: Uuid::new_v4().to_string(),
                        ts: SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .map(|d| d.as_secs() as i64)
                            .unwrap_or(0),
                        role: "agent".to_string(),
                        text: reply,
                        modules,
                    };
                    let append_res = courses::append_chat(&paths, &cid, &agent_msg);
                    match append_res {
                        Ok(_) => json!({ "ok": true, "messageId": agent_msg.id }),
                        Err(e) => json!({ "ok": false, "error": e.to_string() }),
                    }
                }
                Err(e) => json!({ "ok": false, "error": e }),
            },
            Err(e) => json!({ "ok": false, "error": e.to_string() }),
        };
        emit_job_event(&app2, &cid, "refine_structure", payload);
    });
    Ok(())
}

fn parse_refine(v: serde_json::Value) -> Result<(String, Vec<courses::ModuleNode>), String> {
    #[derive(serde::Deserialize)]
    struct Raw {
        reply: String,
        #[serde(default)]
        modules: Vec<courses::SidecarModule>,
    }
    let raw: Raw = serde_json::from_value(v).map_err(|e| e.to_string())?;
    // Assign UUIDs to raw modules so the in-chat tree carries stable ids.
    let modules = raw
        .modules
        .into_iter()
        .map(|m| courses::ModuleNode {
            id: Uuid::new_v4().to_string(),
            title: m.title,
            summary: m.summary.unwrap_or_default(),
            generation_state: "pending".to_string(),
            submodules: m
                .submodules
                .into_iter()
                .map(|s| courses::ModuleNode {
                    id: Uuid::new_v4().to_string(),
                    title: s.title,
                    summary: s.summary.unwrap_or_default(),
                    generation_state: "pending".to_string(),
                    submodules: vec![],
                })
                .collect(),
        })
        .collect();
    Ok((raw.reply, modules))
}

fn spawn_generate_submodule(
    app: &AppHandle,
    db: Arc<Db>,
    paths: Arc<AppPaths>,
    sidecar: Arc<Sidecar>,
    course: db::Course,
    submodule_id: String,
) -> Result<(), String> {
    // Set state to 'generating' before spawning so UI can reflect it on the
    // very next refresh.
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        db::set_module_generation_state(&conn, &submodule_id, "generating")
            .map_err(|e| e.to_string())?;
    }

    let course_md = courses::read_course_md(&paths, &course.id).map_err(|e| e.to_string())?;
    let structure = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        courses::load_structure(&conn, &course.id).map_err(|e| e.to_string())?
    };
    let (mod_node, sub_node) = courses::find_submodule_path(&structure, &submodule_id)
        .ok_or_else(|| format!("submodule not found: {submodule_id}"))?;
    let module_id = mod_node.id.clone();
    let module_title = mod_node.title.clone();
    let module_summary = mod_node.summary.clone();
    let sub_title = sub_node.title.clone();
    let sub_summary = sub_node.summary.clone();
    let memory_files =
        courses::read_memory_files(&paths, &course.id).map_err(|e| e.to_string())?;
    let memory_for_prompt: Vec<serde_json::Value> = memory_files
        .iter()
        .map(|(name, content)| json!({ "filename": name, "content": content }))
        .collect();
    let previous_articles = courses::read_previous_articles(&paths, &structure, &submodule_id);
    let structure_value = serde_json::to_value(&structure).map_err(|e| e.to_string())?;

    let app2 = app.clone();
    let cid = course.id.clone();
    let mid = module_id.clone();
    let sid = submodule_id.clone();

    let fail = |db: &Arc<Db>, app: &AppHandle, cid: &str, sid: &str, err: String| {
        if let Ok(c) = db.0.lock() {
            let _ = db::set_module_generation_state(&c, sid, "failed");
        }
        emit_job_event(app, cid, "generate_submodule", json!({ "ok": false, "error": err }));
    };

    thread::spawn(move || {
        let common = json!({
            "backend": course.agent,
            "topic": course.topic,
            "language": course.language,
            "courseMd": course_md,
            "structure": structure_value,
            "memoryFiles": memory_for_prompt,
            "previousArticles": previous_articles,
            "modulePath": { "title": module_title, "summary": module_summary },
            "submodulePath": { "title": sub_title, "summary": sub_summary },
        });

        // Stage 1 — draft
        emit_stage_event(&app2, &cid, &sid, "draft");
        let draft = match sidecar.call("submodule_draft", common.clone(), Duration::from_secs(240)) {
            Ok(v) => v,
            Err(e) => return fail(&db, &app2, &cid, &sid, format!("draft: {e}")),
        };
        let draft_article = match draft.get("article").and_then(|a| a.as_str()) {
            Some(s) if !s.is_empty() => s.to_string(),
            _ => return fail(&db, &app2, &cid, &sid, "draft returned empty article".into()),
        };

        // Stage 2 — review
        emit_stage_event(&app2, &cid, &sid, "review");
        let mut review_params = common.clone();
        review_params["article"] = json!(draft_article);
        let reviewed = match sidecar.call("submodule_review", review_params, Duration::from_secs(240)) {
            Ok(v) => v,
            Err(e) => return fail(&db, &app2, &cid, &sid, format!("review: {e}")),
        };
        let reviewed_article = reviewed
            .get("article")
            .and_then(|a| a.as_str())
            .map(|s| s.to_string())
            .unwrap_or(draft_article);
        let notes = reviewed
            .get("notes")
            .and_then(|n| n.as_str())
            .unwrap_or("")
            .to_string();

        // Stage 3 — annotate images
        emit_stage_event(&app2, &cid, &sid, "annotate");
        let mut annotate_params = common.clone();
        annotate_params["article"] = json!(reviewed_article);
        let annotated = match sidecar.call(
            "submodule_annotate",
            annotate_params,
            Duration::from_secs(180),
        ) {
            Ok(v) => v,
            Err(e) => return fail(&db, &app2, &cid, &sid, format!("annotate: {e}")),
        };
        let final_article = annotated
            .get("article")
            .and_then(|a| a.as_str())
            .map(|s| s.to_string())
            .unwrap_or(reviewed_article);
        let widgets = annotated
            .get("widgets")
            .cloned()
            .unwrap_or_else(|| json!({}));

        // Persist
        if let Err(e) = courses::write_submodule_article(&paths, &cid, &mid, &sid, &final_article) {
            return fail(&db, &app2, &cid, &sid, e.to_string());
        }
        if let Err(e) = courses::write_submodule_widgets(&paths, &cid, &mid, &sid, &widgets) {
            return fail(&db, &app2, &cid, &sid, e.to_string());
        }
        if let Err(e) = courses::write_submodule_review_notes(&paths, &cid, &mid, &sid, &notes) {
            return fail(&db, &app2, &cid, &sid, e.to_string());
        }
        if let Ok(c) = db.0.lock() {
            let _ = db::set_module_generation_state(&c, &sid, "ready");
        }
        emit_job_event(
            &app2,
            &cid,
            "generate_submodule",
            json!({ "ok": true, "submoduleId": sid }),
        );
    });
    Ok(())
}

#[tauri::command]
fn read_submodule_article(
    paths: tauri::State<'_, Arc<AppPaths>>,
    course_id: String,
    module_id: String,
    submodule_id: String,
) -> Result<courses::SubmoduleContent, String> {
    courses::read_submodule_content(&paths, &course_id, &module_id, &submodule_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn start_generate_submodule(
    app: AppHandle,
    db_state: tauri::State<'_, Arc<Db>>,
    paths_state: tauri::State<'_, Arc<AppPaths>>,
    sidecar_state: tauri::State<'_, Arc<Sidecar>>,
    course_id: String,
    submodule_id: String,
) -> Result<(), String> {
    let course = {
        let conn = db_state.0.lock().map_err(|e| e.to_string())?;
        db::get_course(&conn, &course_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("course not found: {course_id}"))?
    };
    let current_state = {
        let conn = db_state.0.lock().map_err(|e| e.to_string())?;
        db::get_module_generation_state(&conn, &submodule_id).map_err(|e| e.to_string())?
    };
    match current_state.as_deref() {
        None => return Err(format!("submodule not found: {submodule_id}")),
        Some("generating") => return Ok(()), // already running — no-op
        _ => {}
    }
    spawn_generate_submodule(
        &app,
        db_state.inner().clone(),
        paths_state.inner().clone(),
        sidecar_state.inner().clone(),
        course,
        submodule_id,
    )
}

#[tauri::command]
fn start_first_pending_submodule(
    app: AppHandle,
    db_state: tauri::State<'_, Arc<Db>>,
    paths_state: tauri::State<'_, Arc<AppPaths>>,
    sidecar_state: tauri::State<'_, Arc<Sidecar>>,
    course_id: String,
) -> Result<Option<String>, String> {
    let (course, first) = {
        let conn = db_state.0.lock().map_err(|e| e.to_string())?;
        let course = db::get_course(&conn, &course_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("course not found: {course_id}"))?;
        let first = db::first_pending_submodule(&conn, &course_id).map_err(|e| e.to_string())?;
        (course, first)
    };
    let Some((_, sub_id)) = first else {
        return Ok(None);
    };
    spawn_generate_submodule(
        &app,
        db_state.inner().clone(),
        paths_state.inner().clone(),
        sidecar_state.inner().clone(),
        course,
        sub_id.clone(),
    )?;
    Ok(Some(sub_id))
}

#[tauri::command]
fn accept_structure_refinement(
    db_state: tauri::State<'_, Arc<Db>>,
    paths: tauri::State<'_, Arc<AppPaths>>,
    course_id: String,
    message_id: String,
) -> Result<courses::StructureFile, String> {
    let chat = courses::read_chat(&paths, &course_id).map_err(|e| e.to_string())?;
    let agent_idx = chat
        .iter()
        .position(|m| m.id == message_id && m.role == "agent")
        .ok_or_else(|| format!("agent message not found: {message_id}"))?;
    let agent_msg = &chat[agent_idx];
    if agent_msg.modules.is_empty() {
        return Err("message has no proposed structure".to_string());
    }
    let preceding_user = chat[..agent_idx]
        .iter()
        .rev()
        .find(|m| m.role == "user")
        .map(|m| m.text.clone())
        .unwrap_or_default();

    let updates = courses::tree_to_updates(&agent_msg.modules);
    let mut conn = db_state.0.lock().map_err(|e| e.to_string())?;
    let saved = courses::save_structure(&mut conn, &paths, &course_id, updates)
        .map_err(|e| e.to_string())?;
    drop(conn);

    courses::write_refinement_memory(&paths, &course_id, &preceding_user, &agent_msg.text)
        .map_err(|e| e.to_string())?;

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs() as i64;
    let ack = courses::ChatMessage {
        id: Uuid::new_v4().to_string(),
        ts: now,
        role: "system".to_string(),
        text: format!("✓ Принято (ref:{})", message_id),
        modules: vec![],
    };
    courses::append_chat(&paths, &course_id, &ack).map_err(|e| e.to_string())?;

    Ok(saved)
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
            app.manage(Arc::new(db));

            app.manage(Arc::new(AppPaths {
                courses_root: dir.join("courses"),
            }));

            let sidecar = Sidecar::spawn(&sidecar_script_path()).map_err(|e| {
                Box::<dyn std::error::Error>::from(format!("sidecar spawn failed: {e}"))
            })?;
            app.manage(Arc::new(sidecar));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_courses,
            create_course,
            sidecar_call,
            save_wizard_answers,
            start_wizard_questions,
            start_build_structure,
            get_structure,
            save_structure,
            list_chat,
            start_structure_refine,
            accept_structure_refinement,
            start_generate_submodule,
            start_first_pending_submodule,
            read_submodule_article
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

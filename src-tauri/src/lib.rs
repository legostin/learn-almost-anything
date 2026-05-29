use std::path::PathBuf;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

mod courses;
mod db;
mod events;
mod media;
mod settings;
mod share;
mod sidecar;

use courses::{AppPaths, QnA};
use db::{Course, Db};
use events::event_hub;
use settings::{ModelConfig, SettingsState};
use share::ShareState;
use sidecar::Sidecar;

const JOB_EVENT: &str = "agent_job";
const STAGE_EVENT: &str = "agent_stage";
/// Fired when background enrichment (illustrations + test) finishes for an
/// already-readable submodule, so an open reader can reload its content.
const ENRICH_EVENT: &str = "agent_enrich";
/// Fired when the homework assignment chain finishes generating in the
/// background, so the reader can load assignments.
const ASSIGNMENTS_EVENT: &str = "agent_assignments";

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
fn set_course_agent(
    state: tauri::State<'_, Arc<Db>>,
    course_id: String,
    agent: String,
) -> Result<(), String> {
    if agent != "claude" && agent != "codex" {
        return Err(format!("unknown agent: {agent}"));
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs() as i64;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db::set_course_agent(&conn, &course_id, &agent, now).map_err(|e| e.to_string())
}

#[tauri::command]
fn sidecar_call(
    state: tauri::State<'_, Arc<Sidecar>>,
    method: String,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    state
        .call(&method, params, Duration::from_secs(1800))
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
    let payload = json!({
        "courseId": course_id,
        "submoduleId": submodule_id,
        "stage": stage,
    });
    let _ = app.emit(STAGE_EVENT, payload.clone());
    event_hub().publish(STAGE_EVENT, payload);
}

fn emit_progress_event(
    app: &AppHandle,
    course_id: &str,
    submodule_id: &str,
    stage: &str,
    label: &str,
    detail: Option<&str>,
) {
    let mut payload = json!({
        "courseId": course_id,
        "submoduleId": submodule_id,
        "stage": stage,
        "label": label,
    });
    if let Some(d) = detail {
        payload["detail"] = json!(d);
    }
    let _ = app.emit(STAGE_EVENT, payload.clone());
    event_hub().publish(STAGE_EVENT, payload);
}

/// Max attempts (including the first) for a generation stage before it fails.
const STAGE_MAX_ATTEMPTS: u32 = 3;

/// Run a generation stage with retries. Calls `f`; on error, invokes
/// `on_retry(next_attempt, last_error)` so callers can surface the upcoming
/// retry in the UI, then tries again — up to `max_attempts`. Returns the last
/// error if every attempt fails.
fn retry_stage<T, F>(
    max_attempts: u32,
    mut on_retry: impl FnMut(u32, &str),
    mut f: F,
) -> Result<T, String>
where
    F: FnMut() -> Result<T, String>,
{
    let mut last_err = String::new();
    for attempt in 1..=max_attempts {
        match f() {
            Ok(v) => return Ok(v),
            Err(e) => {
                last_err = e;
                if attempt < max_attempts {
                    on_retry(attempt + 1, &last_err);
                }
            }
        }
    }
    Err(last_err)
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
    let _ = app.emit(JOB_EVENT, event.clone());
    event_hub().publish(JOB_EVENT, event);
}

fn emit_enrich_event(app: &AppHandle, course_id: &str, submodule_id: &str) {
    let payload = json!({
        "courseId": course_id,
        "submoduleId": submodule_id,
    });
    let _ = app.emit(ENRICH_EVENT, payload.clone());
    event_hub().publish(ENRICH_EVENT, payload);
}

fn emit_assignments_event(app: &AppHandle, course_id: &str, submodule_id: &str) {
    let payload = json!({
        "courseId": course_id,
        "submoduleId": submodule_id,
    });
    let _ = app.emit(ASSIGNMENTS_EVENT, payload.clone());
    event_hub().publish(ASSIGNMENTS_EVENT, payload);
}

/// Log a finished stage's wall-clock time to stderr and surface it in the UI
/// transcript, so the real per-stage cost is observable.
fn log_timing(
    app: &AppHandle,
    course_id: &str,
    submodule_id: &str,
    stage: &str,
    started: Instant,
) {
    let ms = started.elapsed().as_millis();
    eprintln!("[timing] {stage} {ms}ms");
    emit_progress_event(
        app,
        course_id,
        submodule_id,
        stage,
        "готово",
        Some(&format!("{:.1}s", ms as f64 / 1000.0)),
    );
}

#[tauri::command]
fn start_wizard_questions(
    app: AppHandle,
    db_state: tauri::State<'_, Arc<Db>>,
    sidecar_state: tauri::State<'_, Arc<Sidecar>>,
    settings_state: tauri::State<'_, Arc<SettingsState>>,
    course_id: String,
) -> Result<(), String> {
    let course = {
        let conn = db_state.0.lock().map_err(|e| e.to_string())?;
        db::get_course(&conn, &course_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("course not found: {course_id}"))?
    };
    let sidecar = sidecar_state.inner().clone();
    let model_config = settings_state.stage_model(&course.agent, "planning");
    let app2 = app.clone();
    let cid = course_id.clone();

    thread::spawn(move || {
        let params = json!({
            "backend": course.agent,
            "topic": course.topic,
            "language": course.language,
            "modelConfig": model_config,
        });
        let cb = {
            let app3 = app2.clone();
            let cid3 = cid.clone();
            move |p: sidecar::ProgressPayload| {
                emit_progress_event(&app3, &cid3, &cid3, "structure", &p.label, p.detail.as_deref());
            }
        };
        let payload = match sidecar.call_with_progress(
            "wizard_questions",
            params,
            Duration::from_secs(3000),
            cb,
        ) {
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
    settings_state: tauri::State<'_, Arc<SettingsState>>,
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
    let model_config = settings_state.stage_model(&course.agent, "planning");
    let app2 = app.clone();
    let cid = course_id.clone();

    thread::spawn(move || {
        let params = json!({
            "backend": course.agent,
            "topic": course.topic,
            "language": course.language,
            "courseMd": course_md,
            "modelConfig": model_config,
        });
        let cb = {
            let app3 = app2.clone();
            let cid3 = cid.clone();
            move |p: sidecar::ProgressPayload| {
                emit_progress_event(&app3, &cid3, &cid3, "structure", &p.label, p.detail.as_deref());
            }
        };
        let payload = match sidecar.call_with_progress(
            "build_structure",
            params,
            Duration::from_secs(4200),
            cb,
        ) {
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
    settings_state: tauri::State<'_, Arc<SettingsState>>,
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
    let model_config = settings_state.stage_model(&course.agent, "planning");
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
            "modelConfig": model_config,
        });
        let cb = {
            let app3 = app2.clone();
            let cid3 = cid.clone();
            move |p: sidecar::ProgressPayload| {
                emit_progress_event(&app3, &cid3, &cid3, "structure", &p.label, p.detail.as_deref());
            }
        };
        let payload = match sidecar.call_with_progress(
            "refine_structure",
            params,
            Duration::from_secs(3000),
            cb,
        ) {
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
            test_passed: false,
            submodules: m
                .submodules
                .into_iter()
                .map(|s| courses::ModuleNode {
                    id: Uuid::new_v4().to_string(),
                    title: s.title,
                    summary: s.summary.unwrap_or_default(),
                    generation_state: "pending".to_string(),
                    test_passed: false,
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
    brave_api_key: Option<String>,
    gemini_key: Option<String>,
    writing_model: serde_json::Value,
    tests_model: serde_json::Value,
    gemini_image_model: String,
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

    thread::spawn(move || {
        let total_started = Instant::now();
        let mut common = json!({
            "backend": course.agent,
            "topic": course.topic,
            "language": course.language,
            "courseMd": course_md,
            "structure": structure_value,
            "memoryFiles": memory_for_prompt,
            "previousArticles": previous_articles,
            "modulePath": { "title": module_title, "summary": module_summary },
            "submodulePath": { "title": sub_title, "summary": sub_summary },
            "modelConfig": writing_model,
        });
        if let Some(ref key) = brave_api_key {
            common["braveApiKey"] = json!(key);
        }

        let make_progress_cb = |stage: &'static str| {
            let app3 = app2.clone();
            let cid2 = cid.clone();
            let sid2 = sid.clone();
            move |p: sidecar::ProgressPayload| {
                emit_progress_event(&app3, &cid2, &sid2, stage, &p.label, p.detail.as_deref());
            }
        };

        // Mark the submodule failed, persist the error (so the failed screen can
        // show it after a reopen), and notify the UI.
        let fail = |err: String| {
            let _ = courses::write_submodule_error(&paths, &cid, &mid, &sid, &err);
            if let Ok(c) = db.0.lock() {
                let _ = db::set_module_generation_state(&c, &sid, "failed");
            }
            emit_job_event(
                &app2,
                &cid,
                "generate_submodule",
                json!({ "ok": false, "submoduleId": sid, "error": err }),
            );
        };
        // A fresh run supersedes any previous failure.
        courses::clear_submodule_error(&paths, &cid, &mid, &sid);

        // Draft stage — a single self-editing pass: the agent drafts AND
        // fact-checks / fixes typography / ensures consistency in one call
        // (draft and review were previously two separate LLM round-trips).
        // Resume from the draft checkpoint if a previous run got that far.
        let checkpoint = courses::read_submodule_checkpoint(&paths, &cid, &mid, &sid);
        let resumed_draft = checkpoint
            .as_ref()
            .map(|c| c.stage == "draft")
            .unwrap_or(false);

        let draft_started = Instant::now();
        let (article, draft_widgets, draft_sources, notes) = if resumed_draft {
            let cp = checkpoint.unwrap();
            emit_progress_event(&app2, &cid, &sid, "draft", "продолжаю с чекпоинта", None);
            (cp.article, cp.widgets, cp.sources, cp.notes)
        } else {
            // Retries transient failures (timeout, malformed JSON, empty
            // article) before giving up.
            emit_stage_event(&app2, &cid, &sid, "draft");
            let draft = match retry_stage(
                STAGE_MAX_ATTEMPTS,
                |next, err| {
                    emit_progress_event(
                        &app2,
                        &cid,
                        &sid,
                        "draft",
                        &format!("повтор {next}/{STAGE_MAX_ATTEMPTS}"),
                        Some(err),
                    );
                },
                || {
                    let v = sidecar
                        .call_with_progress(
                            "submodule_draft",
                            common.clone(),
                            Duration::from_secs(1200),
                            make_progress_cb("draft"),
                        )
                        .map_err(|e| e.to_string())?;
                    match v.get("article").and_then(|a| a.as_str()) {
                        Some(s) if !s.trim().is_empty() => Ok(v),
                        _ => Err("вернулась пустая статья".into()),
                    }
                },
            ) {
                Ok(v) => v,
                Err(e) => return fail(format!("draft: {e}")),
            };
            let article = draft
                .get("article")
                .and_then(|a| a.as_str())
                .map(|s| s.to_string())
                .unwrap_or_default();
            let draft_widgets = draft.get("widgets").cloned().unwrap_or_else(|| json!({}));
            let draft_sources = draft.get("sources").cloned().unwrap_or_else(|| json!([]));
            let notes = draft
                .get("notes")
                .and_then(|n| n.as_str())
                .unwrap_or("")
                .to_string();
            let _ = courses::write_submodule_checkpoint(
                &paths,
                &cid,
                &mid,
                &sid,
                &courses::SubmoduleCheckpoint {
                    stage: "draft".into(),
                    article: article.clone(),
                    widgets: draft_widgets.clone(),
                    sources: draft_sources.clone(),
                    notes: notes.clone(),
                },
            );
            (article, draft_widgets, draft_sources, notes)
        };
        log_timing(&app2, &cid, &sid, "draft", draft_started);

        // Stage 3 — validate widgets. JS-only Mermaid sanity check; no LLM
        // call. Diagrams that fail validation are kept but flagged so the
        // UI shows an error block. Soft-fail.
        emit_stage_event(&app2, &cid, &sid, "annotate");
        let annotate_started = Instant::now();
        let mut validate_params = json!({
            "backend": course.agent,
            "article": article,
            "widgets": draft_widgets,
            "modelConfig": writing_model,
        });
        let (final_article, widgets, mut combined_notes) = match sidecar.call_with_progress(
            "submodule_annotate",
            validate_params.take(),
            Duration::from_secs(300),
            make_progress_cb("annotate"),
        ) {
            Ok(v) => {
                let extra_notes = v
                    .get("notes")
                    .and_then(|n| n.as_str())
                    .unwrap_or("")
                    .to_string();
                let mut combined = notes.clone();
                if !extra_notes.is_empty() {
                    if !combined.is_empty() {
                        combined.push_str("\n\n");
                    }
                    combined.push_str(&extra_notes);
                }
                (
                    v.get("article")
                        .and_then(|a| a.as_str())
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| article.clone()),
                    v.get("widgets").cloned().unwrap_or_else(|| draft_widgets.clone()),
                    combined,
                )
            }
            Err(e) => {
                eprintln!("[generate_submodule] validate stage failed (soft): {e}");
                let mut n = notes.clone();
                if !n.is_empty() {
                    n.push_str("\n\n");
                }
                n.push_str(&format!(
                    "_Стадия валидации виджетов не выполнена: {e}. Виджеты сохранены без проверки._"
                ));
                (article.clone(), draft_widgets.clone(), n)
            }
        };
        let notes = std::mem::take(&mut combined_notes);
        log_timing(&app2, &cid, &sid, "annotate", annotate_started);

        // The article is the primary artifact — persist it and mark the
        // submodule readable NOW. Illustrations and the comprehension test are
        // enrichment: they backfill in the background and refresh the reader
        // when done. This drops perceived latency to ≈ draft + annotate.
        if let Err(e) = courses::write_submodule_article(&paths, &cid, &mid, &sid, &final_article) {
            return fail(e.to_string());
        }
        if let Err(e) = courses::write_submodule_widgets(&paths, &cid, &mid, &sid, &widgets) {
            eprintln!("[generate_submodule] write placeholder widgets (non-fatal): {e}");
        }
        if let Err(e) =
            courses::write_submodule_sources(&paths, &cid, &mid, &sid, &draft_sources)
        {
            eprintln!("[generate_submodule] write sources (non-fatal): {e}");
        }
        if let Err(e) = courses::write_submodule_review_notes(&paths, &cid, &mid, &sid, &notes) {
            eprintln!("[generate_submodule] write notes (non-fatal): {e}");
        }
        // The article is durable now — the resume checkpoint + last error are no
        // longer needed, even though enrichment is still pending.
        courses::clear_submodule_checkpoint(&paths, &cid, &mid, &sid);
        courses::clear_submodule_error(&paths, &cid, &mid, &sid);
        if let Ok(c) = db.0.lock() {
            let _ = db::set_module_generation_state(&c, &sid, "ready");
        }
        emit_job_event(
            &app2,
            &cid,
            "generate_submodule",
            json!({ "ok": true, "submoduleId": sid, "enriching": true }),
        );

        // Stages 4 & 5 (background enrichment) are independent — illustration
        // works on the widgets, the test on the final article — so run them
        // concurrently. Test goes on its own thread; illustration runs here.
        // Both soft-fail; the submodule is already readable.
        let test_handle = {
            let sidecar = sidecar.clone();
            let app3 = app2.clone();
            let cid3 = cid.clone();
            let sid3 = sid.clone();
            let test_params = json!({
                "backend": course.agent,
                "topic": course.topic,
                "language": course.language,
                "submodulePath": { "title": sub_title, "summary": sub_summary },
                "article": final_article,
                "modelConfig": tests_model,
            });
            thread::spawn(move || {
                let test_started = Instant::now();
                emit_stage_event(&app3, &cid3, &sid3, "test");
                let cb = {
                    let app4 = app3.clone();
                    let cid4 = cid3.clone();
                    let sid4 = sid3.clone();
                    move |p: sidecar::ProgressPayload| {
                        emit_progress_event(
                            &app4,
                            &cid4,
                            &sid4,
                            "test",
                            &p.label,
                            p.detail.as_deref(),
                        );
                    }
                };
                let out = match sidecar.call_with_progress(
                    "generate_test",
                    test_params,
                    Duration::from_secs(600),
                    cb,
                ) {
                    Ok(v) => v.get("questions").cloned().unwrap_or_else(|| json!([])),
                    Err(e) => {
                        eprintln!("[generate_submodule] test stage failed (soft): {e}");
                        json!([])
                    }
                };
                log_timing(&app3, &cid3, &sid3, "test", test_started);
                out
            })
        };

        // Background — design the homework assignment chain for this submodule.
        let assignments_handle = {
            let sidecar = sidecar.clone();
            let app3 = app2.clone();
            let cid3 = cid.clone();
            let sid3 = sid.clone();
            let params = json!({
                "backend": course.agent,
                "topic": course.topic,
                "language": course.language,
                "submodulePath": { "title": sub_title, "summary": sub_summary },
                "article": final_article,
                "modelConfig": tests_model,
            });
            thread::spawn(move || {
                let started = Instant::now();
                emit_stage_event(&app3, &cid3, &sid3, "assignments");
                let cb = {
                    let app4 = app3.clone();
                    let cid4 = cid3.clone();
                    let sid4 = sid3.clone();
                    move |p: sidecar::ProgressPayload| {
                        emit_progress_event(
                            &app4,
                            &cid4,
                            &sid4,
                            "assignments",
                            &p.label,
                            p.detail.as_deref(),
                        );
                    }
                };
                let out = match sidecar.call_with_progress(
                    "generate_assignments",
                    params,
                    Duration::from_secs(600),
                    cb,
                ) {
                    Ok(v) => v.get("assignments").cloned().unwrap_or_else(|| json!([])),
                    Err(e) => {
                        eprintln!("[generate_submodule] assignments stage failed (soft): {e}");
                        json!([])
                    }
                };
                log_timing(&app3, &cid3, &sid3, "assignments", started);
                out
            })
        };

        // Stage 4 — illustrate. Per image widget: generate (Gemini/Codex) when
        // the agent flagged "generate", else search Brave. Soft on every error.
        let can_illustrate =
            brave_api_key.is_some() || gemini_key.is_some() || course.agent == "codex";
        let widgets = if can_illustrate {
            emit_stage_event(&app2, &cid, &sid, "illustrate");
            let illustrate_started = Instant::now();
            let w = illustrate_widgets(
                &app2,
                &course,
                &mid,
                &sid,
                &paths,
                &sidecar,
                widgets,
                &brave_api_key,
                &gemini_key,
                &writing_model,
                &gemini_image_model,
            );
            log_timing(&app2, &cid, &sid, "illustrate", illustrate_started);
            w
        } else {
            widgets
        };

        let test_questions = test_handle.join().unwrap_or_else(|_| json!([]));
        let assignments = assignments_handle.join().unwrap_or_else(|_| json!([]));

        // Persist enrichment over the placeholders. Non-fatal — the article is
        // already saved and readable.
        if let Err(e) = courses::write_submodule_widgets(&paths, &cid, &mid, &sid, &widgets) {
            eprintln!("[generate_submodule] write widgets (non-fatal): {e}");
        }
        if let Err(e) = courses::write_submodule_test(&paths, &cid, &mid, &sid, &test_questions) {
            eprintln!("[generate_submodule] write test (non-fatal): {e}");
        }
        if let Err(e) =
            courses::write_submodule_assignments(&paths, &cid, &mid, &sid, &assignments)
        {
            eprintln!("[generate_submodule] write assignments (non-fatal): {e}");
        }
        log_timing(&app2, &cid, &sid, "total", total_started);
        // Tell an open reader to reload now that images + test are in.
        emit_enrich_event(&app2, &cid, &sid);
        // Assignments are independent — signal the reader to load them.
        emit_assignments_event(&app2, &cid, &sid);
    });
    Ok(())
}

// Generate one illustration as JPEG bytes. Prefers Gemini (reliable); falls
// back to Codex `$imagegen` for Codex courses. Returns None on any failure so
// the caller can fall back to image search.
fn generate_image_bytes(
    app: &AppHandle,
    course: &db::Course,
    sidecar: &Arc<Sidecar>,
    sub_id: &str,
    description: &str,
    alt: &str,
    gemini_key: &Option<String>,
    gemini_image_model: &str,
) -> Option<Vec<u8>> {
    let prompt = format!(
        "{description}. A clean, modern educational illustration for a course on \"{}\". {alt} Avoid added text labels unless essential.",
        course.topic
    );
    emit_progress_event(
        app,
        &course.id,
        sub_id,
        "illustrate",
        "generating",
        Some(description),
    );

    if let Some(key) = gemini_key {
        match media::gemini_generate_image(key, &prompt, gemini_image_model) {
            Ok(bytes) => match media::bytes_to_jpeg(&bytes, 2000) {
                Ok(jpeg) => return Some(jpeg),
                Err(e) => eprintln!("[illustrate] gemini decode: {e}"),
            },
            Err(e) => eprintln!("[illustrate] gemini generate: {e}"),
        }
    }

    if course.agent == "codex" {
        let params = json!({ "backend": "codex", "prompt": prompt });
        match sidecar.call("generate_image", params, Duration::from_secs(3000)) {
            Ok(v) => {
                if let Some(path) = v.get("path").and_then(|p| p.as_str()) {
                    match std::fs::read(path) {
                        Ok(bytes) => match media::bytes_to_jpeg(&bytes, 2000) {
                            Ok(jpeg) => return Some(jpeg),
                            Err(e) => eprintln!("[illustrate] codex img decode: {e}"),
                        },
                        Err(e) => eprintln!("[illustrate] read codex img '{path}': {e}"),
                    }
                } else {
                    eprintln!("[illustrate] codex $imagegen produced no file");
                }
            }
            Err(e) => eprintln!("[illustrate] codex generate_image: {e}"),
        }
    }
    None
}

fn illustrate_widgets(
    app: &AppHandle,
    course: &db::Course,
    mod_id: &str,
    sub_id: &str,
    paths: &Arc<AppPaths>,
    sidecar: &Arc<Sidecar>,
    widgets: serde_json::Value,
    brave_key: &Option<String>,
    gemini_key: &Option<String>,
    model_config: &serde_json::Value,
    gemini_image_model: &str,
) -> serde_json::Value {
    let can_generate = gemini_key.is_some() || course.agent == "codex";
    if brave_key.is_none() && !can_generate {
        return widgets;
    }
    let mut widgets_map = match widgets.as_object() {
        Some(m) => m.clone(),
        None => return widgets,
    };

    let images_dir =
        media::submodule_images_dir(&paths.course_dir(&course.id), mod_id, sub_id);

    // Collect the image widgets that still need an image (no real url yet).
    // (wid, description, alt, mode)
    let jobs: Vec<(String, String, String, String)> = widgets_map
        .iter()
        .filter_map(|(wid, w)| {
            if w.get("type").and_then(|v| v.as_str()) != Some("image") {
                return None;
            }
            // Skip if the agent already supplied a real URL.
            if w.get("url").and_then(|v| v.as_str()).map(|s| !s.is_empty()).unwrap_or(false) {
                return None;
            }
            let description = w
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if description.is_empty() {
                return None;
            }
            let alt = w.get("alt").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let mode = w.get("mode").and_then(|v| v.as_str()).unwrap_or("search").to_string();
            Some((wid.clone(), description, alt, mode))
        })
        .collect();
    if jobs.is_empty() {
        return widgets;
    }

    // Resolve widgets concurrently — each is independent (own search rounds or
    // generation). Bounded so we don't blow past Brave's rate limit.
    let concurrency = jobs.len().min(3);
    let queue = std::sync::Mutex::new(std::collections::VecDeque::from(jobs));
    let fills: std::sync::Mutex<std::collections::HashMap<String, WidgetFill>> =
        std::sync::Mutex::new(std::collections::HashMap::new());

    std::thread::scope(|s| {
        for _ in 0..concurrency {
            s.spawn(|| loop {
                let job = { queue.lock().unwrap().pop_front() };
                let Some((wid, description, alt, mode)) = job else {
                    break;
                };
                if let Some(fill) = illustrate_one_widget(
                    app,
                    course,
                    sub_id,
                    sidecar,
                    &images_dir,
                    &wid,
                    &description,
                    &alt,
                    &mode,
                    brave_key,
                    gemini_key,
                    model_config,
                    gemini_image_model,
                ) {
                    fills.lock().unwrap().insert(wid, fill);
                }
            });
        }
    });

    for (wid, fill) in fills.into_inner().unwrap() {
        if let Some(w) = widgets_map.get_mut(&wid) {
            w["url"] = json!(fill.url);
            w["placeholder"] = json!(false);
            if fill.generated {
                w["generated"] = json!(true);
            }
            if let Some(src) = fill.source.filter(|s| !s.is_empty()) {
                w["source"] = json!(src);
            }
            if let Some(orig) = fill.original_url {
                w["original_url"] = json!(orig);
            }
        }
    }

    // Clean up the umbrella candidates dir if empty.
    let _ = std::fs::remove_dir(images_dir.join("_candidates"));

    serde_json::Value::Object(widgets_map)
}

/// Resolved image for one widget: the on-disk url plus provenance.
struct WidgetFill {
    url: String,
    source: Option<String>,
    original_url: Option<String>,
    generated: bool,
}

/// Resolve a single image widget: generate (Gemini/Codex) when flagged, else
/// search Brave across up to 3 refined rounds. Returns None to leave a
/// placeholder. Safe to call from multiple threads concurrently.
fn illustrate_one_widget(
    app: &AppHandle,
    course: &db::Course,
    sub_id: &str,
    sidecar: &Arc<Sidecar>,
    images_dir: &std::path::Path,
    wid: &str,
    description: &str,
    alt: &str,
    mode: &str,
    brave_key: &Option<String>,
    gemini_key: &Option<String>,
    model_config: &serde_json::Value,
    gemini_image_model: &str,
) -> Option<WidgetFill> {
    // Generation path: custom illustration the agent flagged as "generate".
    // On success return it; on failure fall through to search below.
    if mode == "generate" {
        if let Some(jpeg) =
            generate_image_bytes(app, course, sidecar, sub_id, description, alt, gemini_key, gemini_image_model)
        {
            let final_path = images_dir.join(format!("{wid}.jpg"));
            match media::save_bytes(&jpeg, &final_path) {
                Ok(()) => {
                    return Some(WidgetFill {
                        url: final_path.to_string_lossy().to_string(),
                        source: None,
                        original_url: None,
                        generated: true,
                    });
                }
                Err(e) => eprintln!("[illustrate] save generated '{wid}': {e}"),
            }
        }
    }

    // Search path — requires a Brave key. Without one, leave a placeholder.
    let key = brave_key.clone()?;
    let mut query = format!("{} {}", description, course.topic);
    let mut tried_urls = std::collections::HashSet::<String>::new();

    for round in 0..3 {
        emit_progress_event(
            app,
            &course.id,
            sub_id,
            "illustrate",
            "searching",
            Some(&format!("{} (round {}/3)", query, round + 1)),
        );
        let hits = match media::brave_image_search(&key, &query, 8) {
            Ok(h) => h,
            Err(e) => {
                eprintln!("[illustrate] brave search '{wid}' round {round}: {e}");
                break;
            }
        };
        let candidates: Vec<media::BraveImageHit> = hits
            .into_iter()
            .filter(|h| !tried_urls.contains(&h.url))
            .take(3)
            .collect();
        if candidates.is_empty() {
            break;
        }
        for c in &candidates {
            tried_urls.insert(c.url.clone());
        }

        let round_dir = images_dir.join("_candidates").join(wid).join(format!("r{round}"));
        emit_progress_event(
            app,
            &course.id,
            sub_id,
            "illustrate",
            "downloading",
            Some(&format!("{}: {} candidate(s)", wid, candidates.len())),
        );
        // Download candidates in parallel, preserving order for the pick index.
        let saved: Vec<(std::path::PathBuf, media::BraveImageHit)> = std::thread::scope(|s| {
            let handles: Vec<_> = candidates
                .iter()
                .enumerate()
                .map(|(i, c)| {
                    let round_dir = round_dir.clone();
                    s.spawn(move || {
                        let bytes = match media::download_resize_jpeg(&c.url, 2000) {
                            Ok(b) => b,
                            Err(e) => {
                                eprintln!("[illustrate] download/resize '{wid}' r{round} #{i}: {e}");
                                return None;
                            }
                        };
                        let p = round_dir.join(format!("{i}.jpg"));
                        if let Err(e) = media::save_bytes(&bytes, &p) {
                            eprintln!("[illustrate] save '{wid}' r{round} #{i}: {e}");
                            return None;
                        }
                        Some((p, c.clone()))
                    })
                })
                .collect();
            handles
                .into_iter()
                .filter_map(|h| h.join().unwrap_or(None))
                .collect()
        });
        if saved.is_empty() {
            continue;
        }

        emit_progress_event(
            app,
            &course.id,
            sub_id,
            "illustrate",
            "reviewing",
            Some(&format!("{wid}: {} candidate(s)", saved.len())),
        );
        let candidates_json: Vec<serde_json::Value> = saved
            .iter()
            .map(|(p, _)| json!({ "path": p.to_string_lossy() }))
            .collect();
        let review_params = json!({
            "backend": course.agent,
            "language": course.language,
            "description": description,
            "alt": alt,
            "topic": course.topic,
            "candidates": candidates_json,
            "modelConfig": model_config,
        });
        match sidecar.call("submodule_review_images", review_params, Duration::from_secs(300)) {
            Ok(v) => {
                let pick = v.get("pick").and_then(|p| p.as_u64()).map(|n| n as usize);
                let refined = v
                    .get("refinedQuery")
                    .and_then(|p| p.as_str())
                    .unwrap_or("")
                    .to_string();
                if let Some(idx) = pick.filter(|i| *i < saved.len()) {
                    let (src_path, hit) = &saved[idx];
                    let final_path = images_dir.join(format!("{wid}.jpg"));
                    if let Err(e) = std::fs::create_dir_all(images_dir) {
                        eprintln!("[illustrate] mkdir final '{wid}': {e}");
                        break;
                    }
                    if let Err(e) = std::fs::copy(src_path, &final_path) {
                        eprintln!("[illustrate] copy final '{wid}': {e}");
                        break;
                    }
                    let fill = WidgetFill {
                        url: final_path.to_string_lossy().to_string(),
                        source: Some(hit.source.clone()),
                        original_url: Some(hit.url.clone()),
                        generated: false,
                    };
                    let _ = std::fs::remove_dir_all(images_dir.join("_candidates").join(wid));
                    return Some(fill);
                }
                if !refined.is_empty() {
                    query = refined;
                }
            }
            Err(e) => {
                eprintln!("[illustrate] review '{wid}' r{round}: {e}");
                break;
            }
        }
    }

    // No pick — drop this widget's candidates and leave a placeholder.
    let _ = std::fs::remove_dir_all(images_dir.join("_candidates").join(wid));
    None
}

#[derive(serde::Serialize)]
struct SettingsStatus {
    brave_configured: bool,
    gemini_configured: bool,
    tts_engine: String,
    tts_voice: String,
    gemini_image_model: String,
    gemini_tts_model: String,
}

fn settings_status(state: &SettingsState) -> SettingsStatus {
    SettingsStatus {
        brave_configured: state.brave_api_key().is_some(),
        gemini_configured: state.gemini_api_key().is_some(),
        tts_engine: state.tts_engine(),
        tts_voice: state.tts_voice(),
        gemini_image_model: state.gemini_image_model(),
        gemini_tts_model: state.gemini_tts_model(),
    }
}

#[derive(serde::Serialize)]
struct AgentAvailability {
    claude: bool,
    codex: bool,
}

fn cli_present(cmd: &str) -> bool {
    std::process::Command::new(cmd)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[tauri::command]
fn check_agent_availability() -> AgentAvailability {
    AgentAvailability {
        claude: cli_present("claude"),
        codex: cli_present("codex"),
    }
}

#[tauri::command]
fn get_settings_status(state: tauri::State<'_, Arc<SettingsState>>) -> SettingsStatus {
    settings_status(&state)
}

#[tauri::command]
fn set_brave_key(
    state: tauri::State<'_, Arc<SettingsState>>,
    key: Option<String>,
) -> Result<SettingsStatus, String> {
    state.set_brave_api_key(key).map_err(|e| e.to_string())?;
    Ok(settings_status(&state))
}

#[tauri::command]
fn set_gemini_key(
    state: tauri::State<'_, Arc<SettingsState>>,
    key: Option<String>,
) -> Result<SettingsStatus, String> {
    state.set_gemini_api_key(key).map_err(|e| e.to_string())?;
    Ok(settings_status(&state))
}

#[tauri::command]
fn set_tts_engine(
    state: tauri::State<'_, Arc<SettingsState>>,
    engine: Option<String>,
) -> Result<SettingsStatus, String> {
    state.set_tts_engine(engine).map_err(|e| e.to_string())?;
    Ok(settings_status(&state))
}

#[tauri::command]
fn set_tts_voice(
    state: tauri::State<'_, Arc<SettingsState>>,
    voice: Option<String>,
) -> Result<SettingsStatus, String> {
    state.set_tts_voice(voice).map_err(|e| e.to_string())?;
    Ok(settings_status(&state))
}

/// Fetch the live catalog of Gemini models for the configured key, split into
/// image- and TTS-capable groups, so the Settings dropdowns reflect reality
/// instead of a hardcoded list.
#[tauri::command]
async fn list_gemini_models(
    state: tauri::State<'_, Arc<SettingsState>>,
) -> Result<serde_json::Value, String> {
    let key = state
        .gemini_api_key()
        .ok_or_else(|| "gemini key not configured".to_string())?;
    tauri::async_runtime::spawn_blocking(move || media::list_gemini_models(&key))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn set_gemini_image_model(
    state: tauri::State<'_, Arc<SettingsState>>,
    model: Option<String>,
) -> Result<SettingsStatus, String> {
    state
        .set_gemini_image_model(model)
        .map_err(|e| e.to_string())?;
    Ok(settings_status(&state))
}

#[tauri::command]
fn set_gemini_tts_model(
    state: tauri::State<'_, Arc<SettingsState>>,
    model: Option<String>,
) -> Result<SettingsStatus, String> {
    state
        .set_gemini_tts_model(model)
        .map_err(|e| e.to_string())?;
    Ok(settings_status(&state))
}

/// Stable 64-bit FNV-1a hash → 16 hex chars. Used as a TTS cache filename.
fn fnv1a64_hex(s: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100_0000_01b3);
    }
    format!("{h:016x}")
}

/// Synthesize speech for the lecture-audio button via Gemini TTS (PAID — bills
/// the configured Gemini key). Returns base64 WAV.
/// - Async + spawn_blocking so the multi-second HTTP call never blocks the UI.
/// - Disk-cached by hash(voice|model|text) so the same chunk is paid for only
///   once, ever (the article-lecture button replays cached audio instantly).
#[tauri::command]
async fn synthesize_speech(
    state: tauri::State<'_, Arc<SettingsState>>,
    text: String,
) -> Result<String, String> {
    use base64::Engine as _;
    let key = state
        .gemini_api_key()
        .ok_or_else(|| "gemini key not configured".to_string())?;
    let voice = state.tts_voice();
    let model = state.gemini_tts_model();
    let cache_dir = state.data_dir.join("tts_cache");
    let cache_key = fnv1a64_hex(&format!("{voice}|{model}|{text}"));
    let cache_path = cache_dir.join(format!("{cache_key}.wav"));

    if let Ok(bytes) = std::fs::read(&cache_path) {
        return Ok(base64::engine::general_purpose::STANDARD.encode(&bytes));
    }

    let wav =
        tauri::async_runtime::spawn_blocking(move || media::gemini_tts(&key, &text, &voice, &model))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;

    let _ = std::fs::create_dir_all(&cache_dir);
    let _ = std::fs::write(&cache_path, &wav);
    Ok(base64::engine::general_purpose::STANDARD.encode(&wav))
}

#[tauri::command]
fn start_share(
    state: tauri::State<'_, Arc<ShareState>>,
    settings: tauri::State<'_, Arc<SettingsState>>,
    domain: Option<String>,
) -> Result<share::ShareInfo, String> {
    let domain = domain
        .map(|d| d.trim().to_string())
        .filter(|d| !d.is_empty());
    let _ = settings.set_share_domain(domain.clone());
    let url = share::start_ngrok(&state, domain.as_deref())?;
    Ok(share::ShareInfo {
        url: Some(url),
        port: share::SHARE_PORT,
    })
}

#[tauri::command]
fn stop_share(state: tauri::State<'_, Arc<ShareState>>) -> Result<(), String> {
    share::stop_ngrok(&state);
    Ok(())
}

#[tauri::command]
fn share_status(state: tauri::State<'_, Arc<ShareState>>) -> share::ShareInfo {
    share::ShareInfo {
        url: state.url(),
        port: share::SHARE_PORT,
    }
}

#[tauri::command]
fn get_model_settings(settings: tauri::State<'_, Arc<SettingsState>>) -> ModelConfig {
    settings.models()
}

#[tauri::command]
fn set_model_settings(
    settings: tauri::State<'_, Arc<SettingsState>>,
    models: ModelConfig,
) -> Result<ModelConfig, String> {
    settings.set_models(models).map_err(|e| e.to_string())?;
    Ok(settings.models())
}

#[derive(serde::Serialize)]
struct ShareSettings {
    domains: Vec<String>,
    selected: Option<String>,
}

#[tauri::command]
fn get_share_settings(settings: tauri::State<'_, Arc<SettingsState>>) -> ShareSettings {
    ShareSettings {
        domains: settings.share_domains(),
        selected: settings.share_domain(),
    }
}

#[tauri::command]
fn set_share_domains(
    settings: tauri::State<'_, Arc<SettingsState>>,
    domains: Vec<String>,
) -> Result<ShareSettings, String> {
    settings.set_share_domains(domains).map_err(|e| e.to_string())?;
    Ok(ShareSettings {
        domains: settings.share_domains(),
        selected: settings.share_domain(),
    })
}

#[tauri::command]
fn delete_course(
    db_state: tauri::State<'_, Arc<Db>>,
    paths: tauri::State<'_, Arc<AppPaths>>,
    course_id: String,
) -> Result<(), String> {
    {
        let conn = db_state.0.lock().map_err(|e| e.to_string())?;
        db::delete_course(&conn, &course_id).map_err(|e| e.to_string())?;
    }
    courses::delete_course_dir(&paths, &course_id).map_err(|e| e.to_string())?;
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
fn read_submodule_error(
    paths: tauri::State<'_, Arc<AppPaths>>,
    course_id: String,
    module_id: String,
    submodule_id: String,
) -> Option<String> {
    courses::read_submodule_error(&paths, &course_id, &module_id, &submodule_id)
}

#[tauri::command]
fn submit_test_result(
    db_state: tauri::State<'_, Arc<Db>>,
    submodule_id: String,
    passed: bool,
) -> Result<(), String> {
    if !passed {
        return Ok(());
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs() as i64;
    let conn = db_state.0.lock().map_err(|e| e.to_string())?;
    db::set_test_passed(&conn, &submodule_id, now).map_err(|e| e.to_string())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Keep only the file-name component and strip anything risky, so an uploaded
/// filename can't escape the assignment's uploads dir.
fn sanitize_filename(name: &str) -> String {
    let base = std::path::Path::new(name)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("file");
    let cleaned: String = base
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        "file".to_string()
    } else {
        trimmed.to_string()
    }
}

#[derive(serde::Deserialize)]
struct UploadFile {
    name: String,
    #[serde(default)]
    base64: String,
}

/// Return the submodule's assignment chain merged with each assignment's
/// current status and review chat.
#[tauri::command]
fn get_assignments(
    paths: tauri::State<'_, Arc<AppPaths>>,
    course_id: String,
    module_id: String,
    submodule_id: String,
) -> Result<serde_json::Value, String> {
    let defs = courses::read_submodule_assignments(&paths, &course_id, &module_id, &submodule_id);
    let arr = defs.as_array().cloned().unwrap_or_default();
    let mut out = Vec::with_capacity(arr.len());
    for a in arr {
        let id = a.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let status =
            courses::read_assignment_status(&paths, &course_id, &module_id, &submodule_id, &id);
        let chat =
            courses::read_assignment_chat(&paths, &course_id, &module_id, &submodule_id, &id);
        let mut obj = a;
        if let Some(map) = obj.as_object_mut() {
            map.insert("status".into(), json!(status));
            map.insert("chat".into(), json!(chat));
        }
        out.push(obj);
    }
    Ok(json!({ "assignments": out }))
}

/// Submit a result for one assignment, run the agent review synchronously, and
/// return the review. Stores files + appends to the assignment's chat.
#[tauri::command]
fn submit_assignment(
    app: AppHandle,
    db_state: tauri::State<'_, Arc<Db>>,
    paths_state: tauri::State<'_, Arc<AppPaths>>,
    sidecar_state: tauri::State<'_, Arc<Sidecar>>,
    settings_state: tauri::State<'_, Arc<SettingsState>>,
    course_id: String,
    module_id: String,
    submodule_id: String,
    assignment_id: String,
    submission_type: String,
    text: Option<String>,
    github_url: Option<String>,
    files: Vec<UploadFile>,
) -> Result<serde_json::Value, String> {
    use base64::Engine as _;

    let course = {
        let conn = db_state.0.lock().map_err(|e| e.to_string())?;
        db::get_course(&conn, &course_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("course not found: {course_id}"))?
    };
    let paths = paths_state.inner().clone();

    // Locate the assignment definition.
    let defs = courses::read_submodule_assignments(&paths, &course_id, &module_id, &submodule_id);
    let assignment = defs
        .as_array()
        .and_then(|arr| {
            arr.iter()
                .find(|a| a.get("id").and_then(|x| x.as_str()) == Some(assignment_id.as_str()))
                .cloned()
        })
        .ok_or_else(|| format!("assignment not found: {assignment_id}"))?;

    let prior_chat =
        courses::read_assignment_chat(&paths, &course_id, &module_id, &submodule_id, &assignment_id);
    let attempt = prior_chat
        .iter()
        .filter(|t| t.get("role").and_then(|r| r.as_str()) == Some("user"))
        .count() as i64
        + 1;

    // Store uploaded files; collect image paths (vision) + extracted text.
    let uploads_dir = courses::assignment_dir(&paths, &course_id, &module_id, &submodule_id, &assignment_id)
        .join("uploads")
        .join(format!("attempt-{attempt}"));
    let mut saved_files: Vec<serde_json::Value> = Vec::new();
    let mut image_paths: Vec<serde_json::Value> = Vec::new();
    let mut extracted_texts: Vec<String> = Vec::new();
    for f in &files {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(f.base64.as_bytes())
            .map_err(|e| format!("bad upload encoding: {e}"))?;
        let safe = sanitize_filename(&f.name);
        let dest = uploads_dir.join(&safe);
        media::save_bytes(&bytes, &dest).map_err(|e| e.to_string())?;
        let path_str = dest.to_string_lossy().to_string();
        saved_files.push(json!({ "name": safe, "path": path_str }));
        if courses::is_image_file(&safe) {
            image_paths.push(json!({ "path": path_str }));
        } else if let Some(t) = courses::extract_submission_text(&dest) {
            extracted_texts.push(format!("File: {safe}\n{t}"));
        }
    }

    // Assemble the textual submission (user text + extracted file content).
    let mut sub_text = String::new();
    if let Some(t) = text.as_deref() {
        if !t.trim().is_empty() {
            sub_text.push_str(t.trim());
            sub_text.push('\n');
        }
    }
    for t in &extracted_texts {
        sub_text.push('\n');
        sub_text.push_str(t);
        sub_text.push('\n');
    }

    // Prior turns → flat history for the reviewer.
    let history: Vec<serde_json::Value> = prior_chat
        .iter()
        .map(|t| {
            let role = t.get("role").and_then(|r| r.as_str()).unwrap_or("user");
            let text = if role == "agent" {
                let summary = t.get("summary").and_then(|s| s.as_str()).unwrap_or("");
                let remarks = t
                    .get("remarks")
                    .and_then(|r| r.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|x| x.get("text").and_then(|s| s.as_str()))
                            .collect::<Vec<_>>()
                            .join("; ")
                    })
                    .unwrap_or_default();
                format!("{summary} {remarks}").trim().to_string()
            } else {
                t.get("text")
                    .and_then(|s| s.as_str())
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or("(submission)")
                    .to_string()
            };
            json!({ "role": role, "text": text })
        })
        .collect();

    // Record the learner's submission turn.
    let user_turn = json!({
        "role": "user",
        "ts": now_ms(),
        "kind": "submission",
        "submissionType": submission_type,
        "text": text.clone().unwrap_or_default(),
        "files": saved_files,
        "githubUrl": github_url.clone().unwrap_or_default(),
    });
    courses::append_assignment_chat(&paths, &course_id, &module_id, &submodule_id, &assignment_id, &user_turn)
        .map_err(|e| e.to_string())?;

    // Run the agent review.
    let tests_model = settings_state.stage_model(&course.agent, "tests");
    let params = json!({
        "backend": course.agent,
        "topic": course.topic,
        "language": course.language,
        "assignment": assignment,
        "submission": {
            "type": submission_type,
            "text": sub_text,
            "images": image_paths,
            "githubUrl": github_url.clone().unwrap_or_default(),
        },
        "history": history,
        "modelConfig": tests_model,
    });
    let review = sidecar_state
        .call("review_assignment", params, Duration::from_secs(900))
        .map_err(|e| e.to_string())?;

    // Record the reviewer's turn + update state.
    let verdict = review.get("verdict").and_then(|v| v.as_str()).unwrap_or("revise");
    let status = if verdict == "passed" { "passed" } else { "in_progress" };
    let agent_turn = json!({
        "role": "agent",
        "ts": now_ms(),
        "kind": "review",
        "verdict": verdict,
        "summary": review.get("summary").cloned().unwrap_or_else(|| json!("")),
        "remarks": review.get("remarks").cloned().unwrap_or_else(|| json!([])),
    });
    courses::append_assignment_chat(&paths, &course_id, &module_id, &submodule_id, &assignment_id, &agent_turn)
        .map_err(|e| e.to_string())?;
    courses::write_assignment_status(&paths, &course_id, &module_id, &submodule_id, &assignment_id, status, attempt)
        .map_err(|e| e.to_string())?;

    emit_assignments_event(&app, &course_id, &submodule_id);
    Ok(json!({ "review": agent_turn, "status": status }))
}

/// Generate (or regenerate) the assignment chain for an already-ready submodule
/// on demand — for content created before assignments existed. Runs in the
/// background and emits `agent_assignments` when done.
#[tauri::command]
fn start_generate_assignments(
    app: AppHandle,
    db_state: tauri::State<'_, Arc<Db>>,
    paths_state: tauri::State<'_, Arc<AppPaths>>,
    sidecar_state: tauri::State<'_, Arc<Sidecar>>,
    settings_state: tauri::State<'_, Arc<SettingsState>>,
    course_id: String,
    module_id: String,
    submodule_id: String,
) -> Result<(), String> {
    let course = {
        let conn = db_state.0.lock().map_err(|e| e.to_string())?;
        db::get_course(&conn, &course_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("course not found: {course_id}"))?
    };
    let paths = paths_state.inner().clone();
    let content = courses::read_submodule_content(&paths, &course_id, &module_id, &submodule_id)
        .map_err(|_| "submodule not ready yet".to_string())?;
    let (sub_title, sub_summary) = {
        let conn = db_state.0.lock().map_err(|e| e.to_string())?;
        let structure = courses::load_structure(&conn, &course_id).map_err(|e| e.to_string())?;
        courses::find_submodule_path(&structure, &submodule_id)
            .map(|(_, s)| (s.title.clone(), s.summary.clone()))
            .ok_or_else(|| format!("submodule not found: {submodule_id}"))?
    };
    let tests_model = settings_state.stage_model(&course.agent, "tests");
    let sidecar = sidecar_state.inner().clone();
    let app2 = app.clone();
    let article = content.article;
    thread::spawn(move || {
        emit_stage_event(&app2, &course_id, &submodule_id, "assignments");
        let cb = {
            let app3 = app2.clone();
            let cid = course_id.clone();
            let sid = submodule_id.clone();
            move |p: sidecar::ProgressPayload| {
                emit_progress_event(&app3, &cid, &sid, "assignments", &p.label, p.detail.as_deref());
            }
        };
        let params = json!({
            "backend": course.agent,
            "topic": course.topic,
            "language": course.language,
            "submodulePath": { "title": sub_title, "summary": sub_summary },
            "article": article,
            "modelConfig": tests_model,
        });
        let out = match sidecar.call_with_progress(
            "generate_assignments",
            params,
            Duration::from_secs(600),
            cb,
        ) {
            Ok(v) => v.get("assignments").cloned().unwrap_or_else(|| json!([])),
            Err(e) => {
                eprintln!("[start_generate_assignments] failed: {e}");
                json!([])
            }
        };
        if let Err(e) =
            courses::write_submodule_assignments(&paths, &course_id, &module_id, &submodule_id, &out)
        {
            eprintln!("[start_generate_assignments] write (non-fatal): {e}");
        }
        emit_assignments_event(&app2, &course_id, &submodule_id);
    });
    Ok(())
}

#[tauri::command]
fn start_generate_submodule(
    app: AppHandle,
    db_state: tauri::State<'_, Arc<Db>>,
    paths_state: tauri::State<'_, Arc<AppPaths>>,
    sidecar_state: tauri::State<'_, Arc<Sidecar>>,
    settings_state: tauri::State<'_, Arc<SettingsState>>,
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
    let writing_model = settings_state.stage_model(&course.agent, "writing");
    let tests_model = settings_state.stage_model(&course.agent, "tests");
    spawn_generate_submodule(
        &app,
        db_state.inner().clone(),
        paths_state.inner().clone(),
        sidecar_state.inner().clone(),
        course,
        submodule_id,
        settings_state.brave_api_key(),
        settings_state.gemini_api_key(),
        writing_model,
        tests_model,
        settings_state.gemini_image_model(),
    )
}

#[tauri::command]
fn start_first_pending_submodule(
    app: AppHandle,
    db_state: tauri::State<'_, Arc<Db>>,
    paths_state: tauri::State<'_, Arc<AppPaths>>,
    sidecar_state: tauri::State<'_, Arc<Sidecar>>,
    settings_state: tauri::State<'_, Arc<SettingsState>>,
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
    let writing_model = settings_state.stage_model(&course.agent, "writing");
    let tests_model = settings_state.stage_model(&course.agent, "tests");
    spawn_generate_submodule(
        &app,
        db_state.inner().clone(),
        paths_state.inner().clone(),
        sidecar_state.inner().clone(),
        course,
        sub_id.clone(),
        settings_state.brave_api_key(),
        settings_state.gemini_api_key(),
        writing_model,
        tests_model,
        settings_state.gemini_image_model(),
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

fn sidecar_script_path(app: &AppHandle) -> PathBuf {
    // Production: scripts/copy-sidecar.mjs copies sidecar/ into src-tauri/
    // before bundling, and tauri.conf "bundle.resources" ships it; at runtime
    // it lives under the bundle's resource_dir.
    if let Ok(res) = app.path().resource_dir() {
        let bundled = res.join("sidecar").join("src").join("index.mjs");
        if bundled.exists() {
            return bundled;
        }
    }
    // Dev fallback: sidecar/ is a sibling of src-tauri/ in the source tree.
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
            {
                let conn = db.0.lock().expect("db lock");
                match db::reset_stuck_generations(&conn) {
                    Ok(n) if n > 0 => {
                        eprintln!("[startup] reset {n} stuck 'generating' submodules → 'failed'");
                    }
                    Ok(_) => {}
                    Err(e) => eprintln!("[startup] reset_stuck_generations: {e}"),
                }
            }
            app.manage(Arc::new(db));

            app.manage(Arc::new(AppPaths {
                courses_root: dir.join("courses"),
            }));

            app.manage(Arc::new(SettingsState::load(dir.clone())));

            let sidecar = Sidecar::spawn(&sidecar_script_path(&app.handle())).map_err(|e| {
                Box::<dyn std::error::Error>::from(format!("sidecar spawn failed: {e}"))
            })?;
            app.manage(Arc::new(sidecar));

            app.manage(Arc::new(ShareState::new()));
            share::start_http_server(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_courses,
            create_course,
            set_course_agent,
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
            read_submodule_article,
            read_submodule_error,
            submit_test_result,
            get_assignments,
            submit_assignment,
            start_generate_assignments,
            delete_course,
            get_settings_status,
            set_brave_key,
            set_gemini_key,
            set_tts_engine,
            set_tts_voice,
            set_gemini_image_model,
            set_gemini_tts_model,
            list_gemini_models,
            synthesize_speech,
            check_agent_availability,
            start_share,
            stop_share,
            share_status,
            get_share_settings,
            set_share_domains,
            get_model_settings,
            set_model_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

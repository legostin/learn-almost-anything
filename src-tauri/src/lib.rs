use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

mod courses;
mod catalog;
mod db;
mod events;
mod media;
mod settings;
mod share;
mod sidecar;

use courses::{AppPaths, QnA};
use db::{Course, Db};
use events::event_hub;
use settings::{GenerationProfile, ModelConfig, SettingsState};
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
const COURSE_SUGGESTION_EVENT: &str = "course_suggestion";
static COURSE_SUGGESTION_RUNNING: AtomicBool = AtomicBool::new(false);

fn now_unix_secs() -> Result<i64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())
        .map(|d| d.as_secs() as i64)
}

fn generated_course_title(value: &Value) -> Option<String> {
    value
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(80).collect::<String>())
}

fn fast_model_config(settings: &SettingsState, backend: &str) -> Value {
    let mut model_config = settings.stage_model(backend, "planning");
    let reasoning = "low";
    if let Value::Object(map) = &mut model_config {
        map.insert("reasoning".to_string(), json!(reasoning));
    }
    model_config
}

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
    course_format: Option<String>,
    agent: Option<String>,
    space_id: Option<String>,
    strict: Option<bool>,
) -> Result<String, String> {
    let agent = agent.unwrap_or_else(|| "claude".to_string());
    if agent != "claude" && agent != "codex" {
        return Err(format!("unknown agent: {agent}"));
    }
    let course_format = db::normalize_course_format(course_format.as_deref());
    let id = Uuid::new_v4().to_string();
    let now = now_unix_secs()?;
    let space = space_id.as_deref().filter(|s| !s.trim().is_empty());
    // Per-course strict override only matters for space-scoped courses.
    let strict = if space.is_some() { strict } else { None };
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    db::insert_course(&conn, &id, &topic, &language, course_format, &agent, now, space, strict)
        .map_err(|e| e.to_string())?;
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
    let now = now_unix_secs()?;
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

fn pick_course_suggestion_backend(requested: Option<String>) -> Result<String, String> {
    let requested = requested
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if let Some(name) = requested {
        if name != "claude" && name != "codex" {
            return Err(format!("unknown agent: {name}"));
        }
        if cli_present(name) {
            return Ok(name.to_string());
        }
    }
    if cli_present("claude") {
        Ok("claude".to_string())
    } else if cli_present("codex") {
        Ok("codex".to_string())
    } else {
        Err("no agent available".to_string())
    }
}

#[tauri::command]
fn start_course_suggestion(
    app: AppHandle,
    db_state: tauri::State<'_, Arc<Db>>,
    sidecar_state: tauri::State<'_, Arc<Sidecar>>,
    settings_state: tauri::State<'_, Arc<SettingsState>>,
    backend: Option<String>,
    language: String,
) -> Result<(), String> {
    let backend = pick_course_suggestion_backend(backend)?;
    let language = language
        .trim()
        .split('-')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or("en")
        .to_string();
    let courses = {
        let conn = db_state.0.lock().map_err(|e| e.to_string())?;
        db::list_courses(&conn).map_err(|e| e.to_string())?
    };
    let course_briefs: Vec<Value> = courses
        .into_iter()
        .take(50)
        .map(|course| {
            json!({
                "topic": course.topic,
                "title": course.title,
                "language": course.language,
                "course_format": course.course_format,
                "status": course.status,
                "agent": course.agent,
            })
        })
        .collect();
    let sidecar = sidecar_state.inner().clone();
    let model_config = fast_model_config(settings_state.inner().as_ref(), &backend);
    let app2 = app.clone();
    if COURSE_SUGGESTION_RUNNING.swap(true, Ordering::AcqRel) {
        return Ok(());
    }

    thread::spawn(move || {
        let params = json!({
            "backend": backend.clone(),
            "language": language.clone(),
            "courses": course_briefs,
            "modelConfig": model_config,
        });
        let payload = match sidecar.call("suggest_course_idea", params, Duration::from_secs(240)) {
            Ok(value) => {
                let topic = value
                    .get("topic")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(|s| s.chars().take(160).collect::<String>());
                match topic {
                    Some(topic) => {
                        let title = value
                            .get("title")
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .map(|s| s.chars().take(120).collect::<String>())
                            .unwrap_or_else(|| topic.clone());
                        let reason = value
                            .get("reason")
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .map(|s| s.chars().take(240).collect::<String>())
                            .unwrap_or_default();
                        json!({
                            "ok": true,
                            "topic": topic,
                            "title": title,
                            "reason": reason,
                            "agent": backend,
                            "language": language,
                        })
                    }
                    None => json!({ "ok": false, "error": "suggestion missing topic" }),
                }
            }
            Err(e) => json!({ "ok": false, "error": e.to_string() }),
        };
        emit_course_suggestion_event(&app2, payload);
        COURSE_SUGGESTION_RUNNING.store(false, Ordering::Release);
    });
    Ok(())
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

#[tauri::command]
fn get_wizard_dialog(
    paths: tauri::State<'_, Arc<AppPaths>>,
    course_id: String,
) -> Result<serde_json::Value, String> {
    courses::read_wizard_dialog(&paths, &course_id).map_err(|e| e.to_string())
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

fn emit_course_suggestion_event(app: &AppHandle, payload: serde_json::Value) {
    let _ = app.emit(COURSE_SUGGESTION_EVENT, payload.clone());
    event_hub().publish(COURSE_SUGGESTION_EVENT, payload);
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

fn strip_widget_markers(article: &str) -> String {
    article
        .lines()
        .filter(|line| !line.trim_start().starts_with("::widget{"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// One step of the adaptive clarifying interview. Given the answers so far,
/// returns the next question (built on them) or done=true. Async + spawn_blocking
/// so the multi-second sidecar call never blocks the UI thread — the wizard shows
/// an animated loader meanwhile. Enforces the 10-question hard cap; the 3-question
/// minimum is enforced in the prompt + frontend. Persists the running dialog so it
/// survives an app restart, and sets the course title on the first call.
#[tauri::command]
async fn wizard_next_question(
    db_state: tauri::State<'_, Arc<Db>>,
    paths_state: tauri::State<'_, Arc<AppPaths>>,
    sidecar_state: tauri::State<'_, Arc<Sidecar>>,
    settings_state: tauri::State<'_, Arc<SettingsState>>,
    course_id: String,
    answered: Vec<courses::QnA>,
) -> Result<serde_json::Value, String> {
    let db = db_state.inner().clone();
    let paths = paths_state.inner().clone();
    let sidecar = sidecar_state.inner().clone();
    let settings = settings_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<serde_json::Value, String> {
        let course = {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            db::get_course(&conn, &course_id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("course not found: {course_id}"))?
        };
        let answered_json = serde_json::to_value(&answered).unwrap_or_else(|_| json!([]));

        // Hard cap: never conduct more than 10 questions, even if the model wants to.
        if answered.len() >= 10 {
            let dialog = json!({ "answered": answered_json, "current": Value::Null, "done": true });
            if let Err(e) = courses::write_wizard_dialog(&paths, &course_id, &dialog) {
                eprintln!("[wizard] write dialog (cap) failed: {e}");
            }
            return Ok(json!({ "done": true }));
        }

        // Durability + in-flight marker: persist the just-submitted answers BEFORE
        // the slow, fallible sidecar call. If it errors, or the app is closed / the
        // view remounts mid-call, the answer is not lost and the dialog reads
        // `pending`, so resume regenerates the next question instead of restarting.
        {
            let pending = json!({
                "answered": answered_json,
                "current": Value::Null,
                "done": false,
                "pending": true,
            });
            if let Err(e) = courses::write_wizard_dialog(&paths, &course_id, &pending) {
                eprintln!("[wizard] pre-step write dialog failed: {e}");
            }
        }

        // Space material (attached docs/links/directories) so the interview can
        // inspect it and ground its questions in what's actually there.
        let (space_sources, space_links, space_dirs, space_strict) = {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            course_space_context(&paths, &conn, &course)
        };
        let model_config = settings.stage_model(&course.agent, "planning");
        let params = json!({
            "backend": course.agent,
            "topic": course.topic,
            "language": course.language,
            "courseFormat": course.course_format,
            "answered": answered_json,
            "modelConfig": model_config,
            "spaceSources": space_sources,
            "spaceLinks": space_links,
            "spaceDirs": space_dirs,
            "spaceStrict": space_strict,
        });
        let step = sidecar
            .call_with_progress(
                "wizard_next_question",
                params,
                Duration::from_secs(600),
                |_p: sidecar::ProgressPayload| {},
            )
            .map_err(|e| e.to_string())?;

        // First question carries the generated course title — persist it.
        if answered.is_empty() {
            if let Some(title) = generated_course_title(&step) {
                if let Ok(conn) = db.0.lock() {
                    if let Ok(now) = now_unix_secs() {
                        let _ = db::set_course_title(&conn, &course_id, &title, now);
                    }
                }
            }
        }

        let current = step.get("question").cloned().unwrap_or(Value::Null);
        let done = step.get("done").and_then(Value::as_bool).unwrap_or(false) || current.is_null();
        let dialog = json!({
            "title": step.get("title").cloned().unwrap_or(Value::Null),
            "answered": answered_json,
            "current": if done { Value::Null } else { current },
            "done": done,
        });
        if let Err(e) = courses::write_wizard_dialog(&paths, &course_id, &dialog) {
            eprintln!("[wizard] write dialog failed: {e}");
        }
        Ok(step)
    })
    .await
    .map_err(|e| e.to_string())?
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

    let (space_sources, space_links, space_dirs, space_strict) = {
        let conn = db_state.0.lock().map_err(|e| e.to_string())?;
        course_space_context(&paths_state, &conn, &course)
    };

    let db = db_state.inner().clone();
    let paths = paths_state.inner().clone();
    let sidecar = sidecar_state.inner().clone();
    // Resolve the profile so the tier tunes planning research depth + reasoning.
    let profile = resolve_course_profile(&settings_state, &course);
    let model_config = apply_tier_reasoning(
        settings_state.stage_model(&course.agent, "planning"),
        &profile,
        "planning",
    );
    let app2 = app.clone();
    let cid = course_id.clone();
    let agent = course.agent.clone();
    let gen_profile = gen_profile_json(&profile, course.category.as_deref());

    thread::spawn(move || {
        let params = json!({
            "backend": course.agent,
            "topic": course.topic,
            "language": course.language,
            "courseFormat": course.course_format,
            "courseMd": course_md,
            "modelConfig": model_config,
            "spaceSources": space_sources,
            "spaceLinks": space_links,
            "spaceDirs": space_dirs,
            "spaceStrict": space_strict,
            "genProfile": gen_profile,
        });
        // Durability: the planning agent can fail (timeout, bad JSON, transient
        // CLI error). Retry up to STAGE_MAX_ATTEMPTS, surfacing each retry in the
        // live transcript. On final failure the UI offers retry / switch agent.
        let result = retry_stage(
            STAGE_MAX_ATTEMPTS,
            |next, err| {
                emit_progress_event(
                    &app2,
                    &cid,
                    &cid,
                    "structure",
                    &format!("повтор {next}/{STAGE_MAX_ATTEMPTS}"),
                    Some(err),
                );
            },
            || {
                let app4 = app2.clone();
                let cid4 = cid.clone();
                let cb = move |p: sidecar::ProgressPayload| {
                    emit_progress_event(&app4, &cid4, &cid4, "structure", &p.label, p.detail.as_deref());
                };
                let v = sidecar
                    .call_with_progress("build_structure", params.clone(), Duration::from_secs(4200), cb)
                    .map_err(|e| e.to_string())?;
                let raw = serde_json::from_value::<courses::SidecarTree>(v)
                    .map_err(|e| format!("sidecar payload: {e}"))?;
                let conn = db.0.lock().map_err(|e| e.to_string())?;
                courses::install_structure(&conn, &paths, &cid, raw).map_err(|e| e.to_string())?;
                Ok::<(), String>(())
            },
        );
        let payload = match result {
            Ok(()) => json!({ "ok": true }),
            Err(e) => json!({ "ok": false, "error": e, "exhausted": true, "agent": agent }),
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
            "courseFormat": course.course_format,
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
            test_passed_at: None,
            prereqs: vec![],
            submodules: m
                .submodules
                .into_iter()
                .map(|s| courses::ModuleNode {
                    id: Uuid::new_v4().to_string(),
                    title: s.title,
                    summary: s.summary.unwrap_or_default(),
                    generation_state: "pending".to_string(),
                    test_passed: false,
                    test_passed_at: None,
                    prereqs: s.prereqs,
                    submodules: vec![],
                })
                .collect(),
        })
        .collect();
    Ok((raw.reply, modules))
}

#[allow(clippy::too_many_arguments)]
fn spawn_next_queued_submodule(
    app: &AppHandle,
    db: Arc<Db>,
    paths: Arc<AppPaths>,
    sidecar: Arc<Sidecar>,
    course: db::Course,
    brave_api_key: Option<String>,
    gemini_key: Option<String>,
    writing_model: serde_json::Value,
    tests_model: serde_json::Value,
    gemini_image_model: String,
    catalog_upload_token: Option<String>,
) -> Result<Option<String>, String> {
    let next = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        if db::has_generating_submodule(&conn, &course.id).map_err(|e| e.to_string())? {
            return Ok(None);
        }
        db::first_queued_submodule(&conn, &course.id).map_err(|e| e.to_string())?
    };
    let Some((_, sub_id)) = next else {
        return Ok(None);
    };
    let started = spawn_generate_submodule(
        app,
        db,
        paths,
        sidecar,
        course,
        sub_id.clone(),
        brave_api_key,
        gemini_key,
        writing_model,
        tests_model,
        gemini_image_model,
        catalog_upload_token,
        true,
        true,
    )?;
    if started {
        Ok(Some(sub_id))
    } else {
        Ok(None)
    }
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
    catalog_upload_token: Option<String>,
    course_serial: bool,
    continue_queued: bool,
) -> Result<bool, String> {
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        if course_serial
            && db::has_generating_submodule(&conn, &course.id).map_err(|e| e.to_string())?
        {
            return Ok(false);
        }
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
        let is_podcast = course.course_format == "podcast_series";
        // Resolved generation profile (per-course override else balanced default).
        // Drives stage gating + is passed to the sidecar for depth/pedagogy.
        let profile: GenerationProfile = course
            .generation_profile
            .as_ref()
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();
        let skip_tests = profile.skip_tests();
        let skip_assignments = profile.skip_assignments();
        // Flashcards are an active-recall extra: skip on the lean pedagogy tier.
        let skip_flashcards = profile.pedagogy_intensity() == "lean";
        let illustration_off = profile.illustration_mode() == "off";
        let gen_profile = gen_profile_json(&profile, course.category.as_deref());
        // Tier reasoning cascade: trim/raise thinking on the dominant draft
        // (writing) and the test/assignment (tests) stages by tier.
        let writing_model = apply_tier_reasoning(writing_model, &profile, "writing");
        let tests_model = apply_tier_reasoning(tests_model, &profile, "tests");
        let total_started = Instant::now();
        let (space_sources, space_links, space_dirs, space_strict) = match db.0.lock() {
            Ok(conn) => course_space_context(&paths, &conn, &course),
            Err(_) => (Vec::new(), Vec::new(), Vec::new(), true),
        };
        let mut common = json!({
            "backend": course.agent,
            "topic": course.topic,
            "language": course.language,
            "courseFormat": course.course_format,
            "courseMd": course_md,
            "structure": structure_value,
            "memoryFiles": memory_for_prompt,
            "previousArticles": previous_articles,
            "modulePath": { "title": module_title, "summary": module_summary },
            "submodulePath": { "title": sub_title, "summary": sub_summary },
            "modelConfig": writing_model,
            "spaceSources": space_sources,
            "spaceLinks": space_links,
            "spaceDirs": space_dirs,
            "spaceStrict": space_strict,
            "category": course.category,
            "genProfile": gen_profile.clone(),
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
        let final_article = if is_podcast {
            strip_widget_markers(&final_article)
        } else {
            final_article
        };
        let widgets = if is_podcast { json!({}) } else { widgets };
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
            if let Ok(now) = now_unix_secs() {
                let _ = db::touch_course(&c, &cid, now);
            }
        }
        let queued_next = if continue_queued {
            match spawn_next_queued_submodule(
                &app2,
                db.clone(),
                paths.clone(),
                sidecar.clone(),
                course.clone(),
                brave_api_key.clone(),
                gemini_key.clone(),
                writing_model.clone(),
                tests_model.clone(),
                gemini_image_model.clone(),
                catalog_upload_token.clone(),
            ) {
                Ok(next) => next,
                Err(e) => {
                    eprintln!("[generate_submodule] continue queued failed: {e}");
                    None
                }
            }
        } else {
            None
        };
        emit_job_event(
            &app2,
            &cid,
            "generate_submodule",
            json!({
                "ok": true,
                "submoduleId": sid,
                "enriching": !is_podcast || !skip_tests,
                "queuedNext": queued_next,
            }),
        );

        // Stages 4 & 5 (background enrichment) are independent — illustration
        // works on the widgets, the test on the final article — so run them
        // concurrently. Test goes on its own thread; illustration runs here.
        // Both soft-fail; the submodule is already readable. Podcasts DO get a
        // recall quiz (episode recall) so spaced review is available to them too;
        // only assignments + illustration stay podcast-off.
        let test_handle = if skip_tests {
            None
        } else {
            let sidecar = sidecar.clone();
            let app3 = app2.clone();
            let cid3 = cid.clone();
            let sid3 = sid.clone();
            let test_params = json!({
                "backend": course.agent,
                "topic": course.topic,
                "language": course.language,
                "courseFormat": course.course_format,
                "submodulePath": { "title": sub_title, "summary": sub_summary },
                "article": final_article,
                "modelConfig": tests_model,
                "genProfile": gen_profile.clone(),
                "category": course.category,
                "structure": structure_value,
            });
            Some(thread::spawn(move || {
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
            }))
        };

        // Background — design the homework assignment chain for this submodule.
        let assignments_handle = if is_podcast || skip_assignments {
            None
        } else {
            let sidecar = sidecar.clone();
            let app3 = app2.clone();
            let cid3 = cid.clone();
            let sid3 = sid.clone();
            let params = json!({
                "backend": course.agent,
                "topic": course.topic,
                "language": course.language,
                "courseFormat": course.course_format,
                "submodulePath": { "title": sub_title, "summary": sub_summary },
                "article": final_article,
                "modelConfig": tests_model,
                "genProfile": gen_profile.clone(),
                "category": course.category,
            });
            Some(thread::spawn(move || {
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
            }))
        };

        // Background — extract active-recall flashcards (lean tier skips them).
        let flashcards_handle = if skip_flashcards {
            None
        } else {
            let sidecar = sidecar.clone();
            let app3 = app2.clone();
            let cid3 = cid.clone();
            let sid3 = sid.clone();
            let params = json!({
                "backend": course.agent,
                "topic": course.topic,
                "language": course.language,
                "courseFormat": course.course_format,
                "submodulePath": { "title": sub_title, "summary": sub_summary },
                "article": final_article,
                "modelConfig": tests_model,
                "genProfile": gen_profile.clone(),
                "category": course.category,
            });
            Some(thread::spawn(move || {
                let started = Instant::now();
                emit_stage_event(&app3, &cid3, &sid3, "flashcards");
                let cb = {
                    let app4 = app3.clone();
                    let cid4 = cid3.clone();
                    let sid4 = sid3.clone();
                    move |p: sidecar::ProgressPayload| {
                        emit_progress_event(
                            &app4,
                            &cid4,
                            &sid4,
                            "flashcards",
                            &p.label,
                            p.detail.as_deref(),
                        );
                    }
                };
                let out = match sidecar.call_with_progress(
                    "generate_flashcards",
                    params,
                    Duration::from_secs(600),
                    cb,
                ) {
                    Ok(v) => v.get("flashcards").cloned().unwrap_or_else(|| json!([])),
                    Err(e) => {
                        eprintln!("[generate_submodule] flashcards stage failed (soft): {e}");
                        json!([])
                    }
                };
                log_timing(&app3, &cid3, &sid3, "flashcards", started);
                out
            }))
        };

        // Stage 4 — illustrate. Per image widget: generate (Gemini/Codex) when
        // flagged, search via Brave when configured, or ask the selected agent
        // to find public source pages when Brave is not.
        let can_illustrate = !is_podcast
            && !illustration_off
            && (brave_api_key.is_some()
                || gemini_key.is_some()
                || matches!(course.agent.as_str(), "claude" | "codex"));
        let widgets = if can_illustrate {
            emit_stage_event(&app2, &cid, &sid, "illustrate");
            let illustrate_started = Instant::now();
            let (illustrated_article, planned_widgets) = plan_illustrations(
                &app2,
                &course,
                &sid,
                &sidecar,
                final_article.clone(),
                widgets,
                &brave_api_key,
                &writing_model,
            );
            if illustrated_article != final_article {
                if let Err(e) =
                    courses::write_submodule_article(&paths, &cid, &mid, &sid, &illustrated_article)
                {
                    eprintln!("[generate_submodule] write illustrated article (non-fatal): {e}");
                }
            }
            let w = illustrate_widgets(
                &app2,
                &course,
                &mid,
                &sid,
                &paths,
                &sidecar,
                planned_widgets,
                &brave_api_key,
                &gemini_key,
                &writing_model,
                &gemini_image_model,
                profile.illustration_mode() == "full",
            );
            log_timing(&app2, &cid, &sid, "illustrate", illustrate_started);
            w
        } else {
            widgets
        };

        let test_questions = test_handle
            .map(|handle| handle.join().unwrap_or_else(|_| json!([])))
            .unwrap_or_else(|| json!([]));
        let assignments = assignments_handle
            .map(|handle| handle.join().unwrap_or_else(|_| json!([])))
            .unwrap_or_else(|| json!([]));
        let flashcards = flashcards_handle
            .map(|handle| handle.join().unwrap_or_else(|_| json!([])))
            .unwrap_or_else(|| json!([]));

        // Persist enrichment over the placeholders. Non-fatal — the article is
        // already saved and readable.
        if let Err(e) = courses::write_submodule_widgets(&paths, &cid, &mid, &sid, &widgets) {
            eprintln!("[generate_submodule] write widgets (non-fatal): {e}");
        }
        if let Err(e) = courses::write_submodule_test(&paths, &cid, &mid, &sid, &test_questions) {
            eprintln!("[generate_submodule] write test (non-fatal): {e}");
        }
        if let Err(e) = courses::write_submodule_flashcards(&paths, &cid, &mid, &sid, &flashcards) {
            eprintln!("[generate_submodule] write flashcards (non-fatal): {e}");
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
        maybe_publish_catalog_update(&db, &paths, &cid, catalog_upload_token);
    });
    Ok(true)
}

fn maybe_publish_catalog_update(
    db: &Arc<Db>,
    paths: &Arc<AppPaths>,
    course_id: &str,
    token: Option<String>,
) {
    let Some(token) = token.map(|value| value.trim().to_string()).filter(|value| !value.is_empty()) else {
        return;
    };
    let package = {
        let Ok(conn) = db.0.lock() else {
            return;
        };
        let Ok(Some(course)) = db::get_course(&conn, course_id) else {
            return;
        };
        if course.catalog_origin_id.as_deref() != Some(&course.id) {
            return;
        }
        if let Ok(now) = now_unix_secs() {
            let _ = db::touch_course(&conn, course_id, now);
        }
        match catalog::build_package(&conn, paths, course_id) {
            Ok(package) => package,
            Err(e) => {
                eprintln!("[catalog] auto-publish package failed: {e}");
                return;
            }
        }
    };
    match catalog::publish_remote(catalog::DEFAULT_CATALOG_URL, &token, &package) {
        Ok(result) => {
            if let Ok(conn) = db.0.lock() {
                if let Ok(now) = now_unix_secs() {
                    let _ = db::set_course_catalog_sync(
                        &conn,
                        course_id,
                        &result.id,
                        result.version.max(package.course.catalog_version),
                        now,
                    );
                }
            }
        }
        Err(e) => eprintln!("[catalog] auto-publish failed: {e}"),
    }
}

fn plan_illustrations(
    app: &AppHandle,
    course: &db::Course,
    submodule_id: &str,
    sidecar: &Arc<Sidecar>,
    article: String,
    widgets: serde_json::Value,
    brave_api_key: &Option<String>,
    model_config: &serde_json::Value,
) -> (String, serde_json::Value) {
    emit_progress_event(
        app,
        &course.id,
        submodule_id,
        "illustrate",
        "marking",
        Some("paragraph-by-paragraph visual pass"),
    );
    let original_article = article.clone();
    let original_widgets = widgets.clone();
    let mut params = json!({
        "backend": course.agent,
        "topic": course.topic,
        "language": course.language,
        "article": article,
        "widgets": widgets,
        "modelConfig": model_config,
    });
    if let Some(ref key) = brave_api_key {
        params["braveApiKey"] = json!(key);
    }
    match sidecar.call_with_progress(
        "plan_illustrations",
        params,
        Duration::from_secs(900),
        {
            let app2 = app.clone();
            let cid = course.id.clone();
            let sid = submodule_id.to_string();
            move |p: sidecar::ProgressPayload| {
                emit_progress_event(&app2, &cid, &sid, "illustrate", &p.label, p.detail.as_deref());
            }
        },
    ) {
        Ok(v) => {
            let article = v
                .get("article")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| original_article.clone());
            let widgets = v
                .get("widgets")
                .cloned()
                .unwrap_or_else(|| original_widgets.clone());
            (article, widgets)
        }
        Err(e) => {
            eprintln!("[illustrate] visual pass failed (soft): {e}");
            (original_article, original_widgets)
        }
    }
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
    illustration_full: bool,
) -> serde_json::Value {
    // AI image generation requires BOTH the global Settings toggle and the
    // course's illustration tier being "full"; "search" tiers find real images
    // only (no Gemini spend), "off" skips the pass upstream.
    let generate_images =
        illustration_full && app.state::<Arc<SettingsState>>().image_generation();
    let can_generate = generate_images && (gemini_key.is_some() || course.agent == "codex");
    let can_agent_search = matches!(course.agent.as_str(), "claude" | "codex");
    if brave_key.is_none() && !can_generate && !can_agent_search {
        return widgets;
    }
    let mut widgets_map = match widgets.as_object() {
        Some(m) => m.clone(),
        None => return widgets,
    };

    let images_dir =
        media::submodule_images_dir(&paths.course_dir(&course.id), mod_id, sub_id);

    // Collect image-like widget entries that need a local image. Gallery items
    // are treated as separate image jobs but written back into their parent
    // gallery. External URLs from the agent are localized; direct hotlinks can
    // go stale or be rejected by the origin.
    // (widget_id, gallery_index, image_key, image_prompt, alt, mode, existing_url, source)
    type ImageJob = (
        String,
        Option<usize>,
        String,
        String,
        String,
        String,
        Option<String>,
        Option<String>,
    );
    let mut jobs: Vec<ImageJob> = Vec::new();
    {
        let mut push_image_job = |widget_id: &str,
                                  gallery_index: Option<usize>,
                                  image_key: String,
                                  w: &serde_json::Value| {
            let existing_url = w
                .get("url")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());
            if existing_url
                .as_deref()
                .map(is_local_widget_url)
                .unwrap_or(false)
            {
                return;
            }
            let image_prompt = w
                .get("prompt")
                .or_else(|| w.get("description"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if image_prompt.is_empty() {
                return;
            }
            let alt = w.get("alt").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let mode = if generate_images {
                w.get("mode").and_then(|v| v.as_str()).unwrap_or("search").to_string()
            } else {
                "search".to_string()
            };
            let source = w
                .get("source")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());
            jobs.push((
                widget_id.to_string(),
                gallery_index,
                image_key,
                image_prompt,
                alt,
                mode,
                existing_url,
                source,
            ));
        };

        for (wid, w) in widgets_map.iter() {
            match w.get("type").and_then(|v| v.as_str()) {
                Some("image") => push_image_job(wid, None, wid.clone(), w),
                Some("gallery") => {
                    if let Some(items) = w.get("items").and_then(|v| v.as_array()) {
                        for (idx, item) in items.iter().enumerate() {
                            push_image_job(wid, Some(idx), format!("{wid}-{idx}"), item);
                        }
                    }
                }
                _ => {}
            }
        }
    }
    if jobs.is_empty() {
        return widgets;
    }

    // Resolve widgets concurrently — each is independent (own search rounds or
    // generation). Bounded so we don't blow past Brave's rate limit.
    let concurrency = jobs.len().min(3);
    let queue = std::sync::Mutex::new(std::collections::VecDeque::from(jobs));
    let fills: std::sync::Mutex<
        std::collections::HashMap<String, (String, Option<usize>, WidgetFill)>,
    > =
        std::sync::Mutex::new(std::collections::HashMap::new());

    std::thread::scope(|s| {
        for _ in 0..concurrency {
            s.spawn(|| loop {
                let job = { queue.lock().unwrap().pop_front() };
                let Some((widget_id, gallery_index, image_key, image_prompt, alt, mode, existing_url, source)) = job else {
                    break;
                };
                if let Some(fill) = illustrate_one_widget(
                    app,
                    course,
                    sub_id,
                    sidecar,
                    &images_dir,
                    &image_key,
                    &image_prompt,
                    &alt,
                    &mode,
                    existing_url.as_deref(),
                    source.as_deref(),
                    brave_key,
                    gemini_key,
                    model_config,
                    gemini_image_model,
                ) {
                    fills
                        .lock()
                        .unwrap()
                        .insert(image_key, (widget_id, gallery_index, fill));
                }
            });
        }
    });

    for (_image_key, (wid, gallery_index, fill)) in fills.into_inner().unwrap() {
        if let Some(w) = widgets_map.get_mut(&wid) {
            if let Some(idx) = gallery_index {
                if let Some(item) = w
                    .get_mut("items")
                    .and_then(|v| v.as_array_mut())
                    .and_then(|items| items.get_mut(idx))
                {
                    item["url"] = json!(fill.url);
                    item["placeholder"] = json!(false);
                    if fill.generated {
                        item["generated"] = json!(true);
                    }
                    if let Some(src) = fill.source.filter(|s| !s.is_empty()) {
                        item["source"] = json!(src);
                    }
                    if let Some(orig) = fill.original_url {
                        item["original_url"] = json!(orig);
                    }
                }
            } else {
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
    }

    // Clean up the umbrella candidates dir if empty.
    let _ = std::fs::remove_dir(images_dir.join("_candidates"));

    serde_json::Value::Object(widgets_map)
}

const WIKIMEDIA_THUMB_STEPS: &[u32] =
    &[20, 40, 60, 120, 250, 330, 500, 960, 1280, 1920, 3840];

fn is_local_widget_url(url: &str) -> bool {
    url.starts_with('/') || url.starts_with("file://")
}

fn normalize_wikimedia_thumbnail_url(url: &str) -> String {
    if !url.starts_with("https://upload.wikimedia.org/") || !url.contains("/thumb/") {
        return url.to_string();
    }
    let Some((prefix, file)) = url.rsplit_once('/') else {
        return url.to_string();
    };
    let Some((width, rest)) = file.split_once("px-") else {
        return url.to_string();
    };
    let Ok(width) = width.parse::<u32>() else {
        return url.to_string();
    };
    if WIKIMEDIA_THUMB_STEPS.contains(&width) {
        return url.to_string();
    }
    let step = WIKIMEDIA_THUMB_STEPS
        .iter()
        .copied()
        .find(|s| *s >= width)
        .unwrap_or_else(|| *WIKIMEDIA_THUMB_STEPS.last().unwrap());
    format!("{prefix}/{step}px-{rest}")
}

/// Resolved image for one widget: the on-disk url plus provenance.
struct WidgetFill {
    url: String,
    source: Option<String>,
    original_url: Option<String>,
    generated: bool,
}

fn expand_image_hits(
    hits: Vec<media::BraveImageHit>,
    tried_urls: &mut std::collections::HashSet<String>,
) -> Vec<media::BraveImageHit> {
    let mut candidates = Vec::new();
    for hit in hits.into_iter().take(6) {
        for candidate in media::expanded_image_candidates(&hit, 4) {
            if candidate.url.is_empty() || tried_urls.contains(&candidate.url) {
                continue;
            }
            tried_urls.insert(candidate.url.clone());
            candidates.push(candidate);
            if candidates.len() >= 5 {
                return candidates;
            }
        }
    }
    candidates
}

fn agent_image_search(
    app: &AppHandle,
    course: &db::Course,
    sub_id: &str,
    sidecar: &Arc<Sidecar>,
    description: &str,
    alt: &str,
    query: &str,
    model_config: &serde_json::Value,
) -> (Vec<media::BraveImageHit>, String) {
    let params = json!({
        "backend": course.agent,
        "language": course.language,
        "description": description,
        "alt": alt,
        "topic": course.topic,
        "query": query,
        "modelConfig": model_config,
    });
    let value = match sidecar.call_with_progress(
        "search_image_candidates",
        params,
        Duration::from_secs(300),
        |p| {
            emit_progress_event(
                app,
                &course.id,
                sub_id,
                "illustrate",
                &p.label,
                p.detail.as_deref(),
            )
        },
    ) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[illustrate] agent image search: {e}");
            return (Vec::new(), String::new());
        }
    };
    let refined = value
        .get("refinedQuery")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let hits = value
        .get("candidates")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|candidate| {
                    let url = candidate
                        .get("url")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    let source_raw = candidate
                        .get("source")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    if url.is_empty() && source_raw.is_empty() {
                        return None;
                    }
                    let source = if source_raw.is_empty() {
                        url.clone()
                    } else {
                        source_raw
                    };
                    Some(media::BraveImageHit {
                        title: candidate
                            .get("title")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        source,
                        url,
                        thumbnail: String::new(),
                        width: None,
                        height: None,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    (hits, refined)
}

/// Resolve a single image widget: generate (Gemini/Codex) when flagged, else
/// search Brave or the selected agent across up to 3 refined rounds. Returns
/// None to leave a placeholder. Safe to call from multiple threads concurrently.
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
    existing_url: Option<&str>,
    existing_source: Option<&str>,
    brave_key: &Option<String>,
    gemini_key: &Option<String>,
    model_config: &serde_json::Value,
    gemini_image_model: &str,
) -> Option<WidgetFill> {
    if let Some(url) = existing_url.filter(|u| u.starts_with("https://")) {
        let normalized_url = normalize_wikimedia_thumbnail_url(url);
        match media::download_resize_jpeg(&normalized_url, 2000) {
            Ok(jpeg) => {
                let final_path = images_dir.join(format!("{wid}.jpg"));
                match media::save_bytes(&jpeg, &final_path) {
                    Ok(()) => {
                        return Some(WidgetFill {
                            url: final_path.to_string_lossy().to_string(),
                            source: existing_source.map(|s| s.to_string()),
                            original_url: Some(url.to_string()),
                            generated: false,
                        });
                    }
                    Err(e) => eprintln!("[illustrate] save external '{wid}': {e}"),
                }
            }
            Err(e) => eprintln!("[illustrate] external image '{wid}': {e}"),
        }
    }

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

    // Search path. Brave is preferred when configured; otherwise ask the
    // selected agent to find public source pages, then extract images locally.
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
        let mut next_query = String::new();
        let hits = if let Some(key) = brave_key.as_deref() {
            match media::brave_image_search(key, &query, 8) {
                Ok(h) => h,
                Err(e) => {
                    eprintln!("[illustrate] brave search '{wid}' round {round}: {e}");
                    break;
                }
            }
        } else {
            let (hits, refined) = agent_image_search(
                app,
                course,
                sub_id,
                sidecar,
                description,
                alt,
                &query,
                model_config,
            );
            next_query = refined;
            hits
        };
        let candidates = expand_image_hits(hits, &mut tried_urls);
        if candidates.is_empty() {
            if !next_query.is_empty() && next_query != query {
                query = next_query;
                continue;
            }
            break;
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
    catalog_upload_token_configured: bool,
    mcp_servers: Vec<McpServerStatus>,
    tts_engine: String,
    tts_voice: String,
    gemini_image_model: String,
    gemini_tts_model: String,
    debug_logging: bool,
    image_generation: bool,
}

#[derive(serde::Serialize)]
struct McpServerStatus {
    id: String,
    name: String,
    enabled_for: Vec<String>,
    tools: Vec<String>,
    source: String,
}

fn settings_status(state: &SettingsState) -> SettingsStatus {
    let brave_configured = state.brave_api_key().is_some();
    let mut mcp_servers = vec![
        McpServerStatus {
            id: "context7".to_string(),
            name: "Context7".to_string(),
            enabled_for: vec!["Claude".to_string(), "Codex".to_string()],
            tools: vec![
                "resolve-library-id".to_string(),
                "query-docs".to_string(),
            ],
            source: "bundled".to_string(),
        },
        McpServerStatus {
            id: "mediawiki".to_string(),
            name: "Wikimedia / MediaWiki".to_string(),
            enabled_for: vec!["Claude".to_string(), "Codex".to_string()],
            tools: vec![
                "search-page".to_string(),
                "get-page".to_string(),
                "get-file".to_string(),
                "list-wikis".to_string(),
            ],
            source: "read-only config".to_string(),
        },
    ];
    if brave_configured {
        mcp_servers.push(McpServerStatus {
            id: "brave".to_string(),
            name: "Brave Search".to_string(),
            enabled_for: vec!["Claude".to_string(), "Codex".to_string()],
            tools: vec![
                "brave_web_search".to_string(),
                "brave_image_search".to_string(),
            ],
            source: "settings.json".to_string(),
        });
    }
    SettingsStatus {
        brave_configured,
        gemini_configured: state.gemini_api_key().is_some(),
        catalog_upload_token_configured: state.catalog_upload_token().is_some(),
        mcp_servers,
        tts_engine: state.tts_engine(),
        tts_voice: state.tts_voice(),
        gemini_image_model: state.gemini_image_model(),
        gemini_tts_model: state.gemini_tts_model(),
        debug_logging: state.debug_logging(),
        image_generation: state.image_generation(),
    }
}

#[derive(serde::Serialize)]
struct AgentAvailability {
    claude: bool,
    codex: bool,
}

fn cli_present(cmd: &str) -> bool {
    sidecar::command_path(cmd).is_absolute()
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
fn set_catalog_upload_token(
    state: tauri::State<'_, Arc<SettingsState>>,
    token: Option<String>,
) -> Result<SettingsStatus, String> {
    state
        .set_catalog_upload_token(token)
        .map_err(|e| e.to_string())?;
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
fn list_catalog_courses(
    query: Option<String>,
) -> Result<Vec<catalog::CatalogCourseSummary>, String> {
    catalog::list_remote(catalog::DEFAULT_CATALOG_URL, query.as_deref())
}

#[tauri::command]
fn publish_course_to_catalog(
    db_state: tauri::State<'_, Arc<Db>>,
    paths: tauri::State<'_, Arc<AppPaths>>,
    settings: tauri::State<'_, Arc<SettingsState>>,
    course_id: String,
) -> Result<catalog::CatalogPublishResult, String> {
    let package = {
        let conn = db_state.0.lock().map_err(|e| e.to_string())?;
        catalog::build_package(&conn, &paths, &course_id)?
    };
    let token = settings
        .catalog_upload_token()
        .ok_or_else(|| "catalog upload token is not configured".to_string())?;
    let result = catalog::publish_remote(catalog::DEFAULT_CATALOG_URL, &token, &package)?;
    {
        let conn = db_state.0.lock().map_err(|e| e.to_string())?;
        db::set_course_catalog_sync(
            &conn,
            &course_id,
            &result.id,
            result.version.max(package.course.catalog_version),
            now_unix_secs()?,
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(result)
}

#[tauri::command]
fn download_catalog_course(
    db_state: tauri::State<'_, Arc<Db>>,
    paths: tauri::State<'_, Arc<AppPaths>>,
    catalog_id: String,
) -> Result<String, String> {
    let package = catalog::download_remote(catalog::DEFAULT_CATALOG_URL, &catalog_id)?;
    let conn = db_state.0.lock().map_err(|e| e.to_string())?;
    catalog::install_package(&conn, &paths, package)
}

// Async + spawn_blocking: this hits the remote catalog over the network, and a
// sync command would block Tauri's main thread on every ready-course open — which
// froze the plan page when the catalog endpoint is slow/unreachable.
#[tauri::command]
async fn get_catalog_update(
    db_state: tauri::State<'_, Arc<Db>>,
    course_id: String,
) -> Result<catalog::CatalogUpdateStatus, String> {
    let db = db_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<catalog::CatalogUpdateStatus, String> {
        let remote = catalog::list_remote(catalog::DEFAULT_CATALOG_URL, None)?;
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let course = db::get_course(&conn, &course_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("course not found: {course_id}"))?;
        Ok(catalog::check_update(&conn, &course, &remote))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn update_catalog_course(
    db_state: tauri::State<'_, Arc<Db>>,
    paths: tauri::State<'_, Arc<AppPaths>>,
    course_id: String,
) -> Result<String, String> {
    let catalog_id = {
        let conn = db_state.0.lock().map_err(|e| e.to_string())?;
        let course = db::get_course(&conn, &course_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("course not found: {course_id}"))?;
        course
            .catalog_origin_id
            .unwrap_or_else(|| course.id.clone())
    };
    let package = catalog::download_remote(catalog::DEFAULT_CATALOG_URL, &catalog_id)?;
    let conn = db_state.0.lock().map_err(|e| e.to_string())?;
    catalog::update_installed_course(&conn, &paths, &course_id, package)
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

/// Map a 0..1 test ratio to an SM-2 quality grade (0..5).
fn ratio_to_quality(ratio: f64) -> u8 {
    if ratio >= 0.95 {
        5
    } else if ratio >= 0.85 {
        4
    } else if ratio >= 0.7 {
        3
    } else if ratio >= 0.5 {
        2
    } else {
        1
    }
}

#[tauri::command]
fn submit_test_result(
    db_state: tauri::State<'_, Arc<Db>>,
    paths: tauri::State<'_, Arc<AppPaths>>,
    submodule_id: String,
    ratio: f64,
    results: Vec<bool>,
    passed: bool,
    weak_concepts: Option<Vec<String>>,
) -> Result<(), String> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs() as i64;
    let conn = db_state.0.lock().map_err(|e| e.to_string())?;
    // Detect the FIRST attempt before recording: weak-spot diagnosis must reflect
    // honest first-attempt struggles, not a brute-forced retake.
    let is_first_attempt = db::first_attempt_ratio(&conn, &submodule_id)
        .map_err(|e| e.to_string())?
        .is_none();
    // Always record the attempt (even failures) so spaced review and weak-spot
    // diagnosis see honest first-attempt performance; pass also gates progress.
    db::record_test_attempt(&conn, &submodule_id, ratio, &results, now).map_err(|e| e.to_string())?;
    // On the first attempt, persist the concepts missed so a targeted redraft (or
    // any future generation) emphasizes them. Cheap: writes one course-memory file.
    if is_first_attempt {
        if let Some(weak) = weak_concepts.as_ref() {
            let weak: Vec<String> = weak
                .iter()
                .map(|c| c.trim().to_string())
                .filter(|c| !c.is_empty())
                .collect();
            if !weak.is_empty() {
                if let Some(course_id) =
                    db::course_id_for_submodule(&conn, &submodule_id).map_err(|e| e.to_string())?
                {
                    let title = courses::load_structure(&conn, &course_id)
                        .ok()
                        .and_then(|s| {
                            courses::find_submodule_path(&s, &submodule_id)
                                .map(|(_, sub)| sub.title.clone())
                        })
                        .unwrap_or_else(|| submodule_id.clone());
                    if let Err(e) = courses::write_weakspot_memory(
                        &paths,
                        &course_id,
                        &submodule_id,
                        &title,
                        &weak,
                    ) {
                        eprintln!("weak-spot memory write failed: {e}");
                    }
                }
            }
        }
    }
    if passed {
        db::set_test_passed(&conn, &submodule_id, now).map_err(|e| e.to_string())?;
        // Seed spaced review on first pass, graded by the honest FIRST-attempt
        // ratio (so brute-forcing the retake can't win a long interval).
        if db::get_review(&conn, &submodule_id)
            .map_err(|e| e.to_string())?
            .is_none()
        {
            if let Some(course_id) =
                db::course_id_for_submodule(&conn, &submodule_id).map_err(|e| e.to_string())?
            {
                let seed_ratio = db::first_attempt_ratio(&conn, &submodule_id)
                    .map_err(|e| e.to_string())?
                    .unwrap_or(ratio);
                db::apply_review_grade(
                    &conn,
                    &submodule_id,
                    &course_id,
                    ratio_to_quality(seed_ratio),
                    now,
                )
                .map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn get_due_reviews(
    db_state: tauri::State<'_, Arc<Db>>,
    course_id: Option<String>,
) -> Result<Vec<db::DueReview>, String> {
    let now = now_unix_secs()?;
    let conn = db_state.0.lock().map_err(|e| e.to_string())?;
    db::get_due_reviews(&conn, course_id.as_deref(), now, 100).map_err(|e| e.to_string())
}

#[tauri::command]
fn due_review_counts(
    db_state: tauri::State<'_, Arc<Db>>,
) -> Result<std::collections::HashMap<String, i64>, String> {
    let now = now_unix_secs()?;
    let conn = db_state.0.lock().map_err(|e| e.to_string())?;
    db::due_review_counts(&conn, now).map_err(|e| e.to_string())
}

#[tauri::command]
fn grade_review(
    db_state: tauri::State<'_, Arc<Db>>,
    submodule_id: String,
    ratio: f64,
) -> Result<(), String> {
    let now = now_unix_secs()?;
    let conn = db_state.0.lock().map_err(|e| e.to_string())?;
    let course_id = db::course_id_for_submodule(&conn, &submodule_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("submodule not found: {submodule_id}"))?;
    db::apply_review_grade(&conn, &submodule_id, &course_id, ratio_to_quality(ratio), now)
        .map_err(|e| e.to_string())
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
        "courseFormat": course.course_format,
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
    if course.course_format == "podcast_series" {
        return Ok(());
    }
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
            "courseFormat": course.course_format,
            "submodulePath": { "title": sub_title, "summary": sub_summary },
            "article": article,
            "modelConfig": tests_model,
            "category": course.category,
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

/// Generate (or regenerate) active-recall flashcards for an already-ready
/// submodule. Used to retrofit decks onto courses generated before flashcards
/// existed. Writes flashcards.json and signals the reader to reload.
#[tauri::command]
fn start_generate_flashcards(
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
    let profile = resolve_course_profile(&settings_state, &course);
    let gen_profile = gen_profile_json(&profile, course.category.as_deref());
    let tests_model = settings_state.stage_model(&course.agent, "tests");
    let sidecar = sidecar_state.inner().clone();
    let app2 = app.clone();
    let article = content.article;
    thread::spawn(move || {
        emit_stage_event(&app2, &course_id, &submodule_id, "flashcards");
        let cb = {
            let app3 = app2.clone();
            let cid = course_id.clone();
            let sid = submodule_id.clone();
            move |p: sidecar::ProgressPayload| {
                emit_progress_event(&app3, &cid, &sid, "flashcards", &p.label, p.detail.as_deref());
            }
        };
        let params = json!({
            "backend": course.agent,
            "topic": course.topic,
            "language": course.language,
            "courseFormat": course.course_format,
            "submodulePath": { "title": sub_title, "summary": sub_summary },
            "article": article,
            "modelConfig": tests_model,
            "genProfile": gen_profile,
            "category": course.category,
        });
        let out = match sidecar.call_with_progress(
            "generate_flashcards",
            params,
            Duration::from_secs(600),
            cb,
        ) {
            Ok(v) => v.get("flashcards").cloned().unwrap_or_else(|| json!([])),
            Err(e) => {
                eprintln!("[start_generate_flashcards] failed: {e}");
                json!([])
            }
        };
        if let Err(e) =
            courses::write_submodule_flashcards(&paths, &course_id, &module_id, &submodule_id, &out)
        {
            eprintln!("[start_generate_flashcards] write (non-fatal): {e}");
        }
        emit_enrich_event(&app2, &course_id, &submodule_id);
    });
    Ok(())
}

/// Retry only the illustration enrichment for an already-readable submodule.
/// The article, test and assignment state are left intact.
#[tauri::command]
fn start_illustrate_submodule(
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
    if course.course_format == "podcast_series" {
        return Ok(());
    }
    let paths = paths_state.inner().clone();
    let content = courses::read_submodule_content(&paths, &course_id, &module_id, &submodule_id)
        .map_err(|_| "submodule not ready yet".to_string())?;
    let sidecar = sidecar_state.inner().clone();
    let brave_api_key = settings_state.brave_api_key();
    let gemini_key = settings_state.gemini_api_key();
    let writing_model = settings_state.stage_model(&course.agent, "writing");
    let gemini_image_model = settings_state.gemini_image_model();
    let app2 = app.clone();

    thread::spawn(move || {
        emit_stage_event(&app2, &course_id, &submodule_id, "illustrate");
        let started = Instant::now();
        let (article, widgets) = plan_illustrations(
            &app2,
            &course,
            &submodule_id,
            &sidecar,
            content.article,
            content.widgets,
            &brave_api_key,
            &writing_model,
        );
        if let Err(e) =
            courses::write_submodule_article(&paths, &course_id, &module_id, &submodule_id, &article)
        {
            eprintln!("[start_illustrate_submodule] write article (non-fatal): {e}");
        }
        let widgets = illustrate_widgets(
            &app2,
            &course,
            &module_id,
            &submodule_id,
            &paths,
            &sidecar,
            widgets,
            &brave_api_key,
            &gemini_key,
            &writing_model,
            &gemini_image_model,
            true, // explicit "illustrate now" action — allow generation
        );
        log_timing(&app2, &course_id, &submodule_id, "illustrate", started);
        if let Err(e) = courses::write_submodule_widgets(
            &paths,
            &course_id,
            &module_id,
            &submodule_id,
            &widgets,
        ) {
            eprintln!("[start_illustrate_submodule] write widgets (non-fatal): {e}");
        }
        emit_enrich_event(&app2, &course_id, &submodule_id);
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
        settings_state.catalog_upload_token(),
        false,
        true,
    )
    .map(|_| ())
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
    let started = spawn_generate_submodule(
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
        settings_state.catalog_upload_token(),
        true,
        true,
    )?;
    if started {
        Ok(Some(sub_id))
    } else {
        Ok(None)
    }
}

#[tauri::command]
fn start_full_course_generation(
    app: AppHandle,
    db_state: tauri::State<'_, Arc<Db>>,
    paths_state: tauri::State<'_, Arc<AppPaths>>,
    sidecar_state: tauri::State<'_, Arc<Sidecar>>,
    settings_state: tauri::State<'_, Arc<SettingsState>>,
    course_id: String,
) -> Result<Option<String>, String> {
    let course = {
        let conn = db_state.0.lock().map_err(|e| e.to_string())?;
        let course = db::get_course(&conn, &course_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("course not found: {course_id}"))?;
        let queued = db::queue_pending_submodules(&conn, &course_id).map_err(|e| e.to_string())?;
        if queued > 0 {
            if let Ok(now) = now_unix_secs() {
                let _ = db::touch_course(&conn, &course_id, now);
            }
        }
        course
    };
    let writing_model = settings_state.stage_model(&course.agent, "writing");
    let tests_model = settings_state.stage_model(&course.agent, "tests");
    spawn_next_queued_submodule(
        &app,
        db_state.inner().clone(),
        paths_state.inner().clone(),
        sidecar_state.inner().clone(),
        course,
        settings_state.brave_api_key(),
        settings_state.gemini_api_key(),
        writing_model,
        tests_model,
        settings_state.gemini_image_model(),
        settings_state.catalog_upload_token(),
    )
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

// On Windows, Tauri's resource_dir() returns a verbatim extended-length path
// (`\\?\C:\...`). Node's main-module resolver chokes on that prefix and aborts
// at startup with `EISDIR: lstat 'C:'`, which kills the sidecar before it can
// serve a single request (the user sees a broken-pipe "os error 232"). Strip
// the prefix so the path we hand to `node` is a plain one. No-op elsewhere.
fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path
}

fn sidecar_script_path(app: &AppHandle) -> PathBuf {
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri has a parent")
        .join("sidecar")
        .join("src")
        .join("index.mjs");
    // Dev (debug builds): run the live source directly so sidecar edits take
    // effect on an app restart. The staged resource copy under target/ is only
    // refreshed by `pnpm build` (copy-sidecar.mjs), not by `tauri dev`, so
    // preferring it in dev silently runs stale agent code.
    #[cfg(debug_assertions)]
    if source.exists() {
        return source;
    }
    // Production: scripts/copy-sidecar.mjs copies sidecar/ into src-tauri/
    // before bundling, and tauri.conf "bundle.resources" ships it; at runtime
    // it lives under the bundle's resource_dir.
    if let Ok(res) = app.path().resource_dir() {
        let bundled = res.join("sidecar").join("src").join("index.mjs");
        if bundled.exists() {
            return strip_verbatim_prefix(bundled);
        }
    }
    // Fallback: the source tree (also covers a release build run from source).
    source
}

// Path of the dev-only agent transcript log the sidecar writes (see
// sidecar/src/lib/devlog.mjs). Mirrors that module's default location.
fn dev_log_path(app: &AppHandle) -> PathBuf {
    if let Ok(dir) = std::env::var("LEARN_ANYTHING_DEVLOG_DIR") {
        return PathBuf::from(dir).join("agents.log");
    }
    let home = app
        .path()
        .home_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    home.join(".learn-anything").join("devlogs").join("agents.log")
}

/// Presence of this file (a sibling of agents.log) tells the sidecar's devlog
/// module that debug logging is on. Using a file rather than a spawn-time env
/// var lets the Settings toggle take effect immediately, without an app restart.
fn devlog_flag_path(app: &AppHandle) -> PathBuf {
    dev_log_path(app).with_file_name("enabled")
}

/// Create/remove the devlog flag file to match the debug-logging setting.
fn sync_devlog_flag(app: &AppHandle, enabled: bool) {
    let path = devlog_flag_path(app);
    if enabled {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&path, b"1");
    } else {
        let _ = std::fs::remove_file(&path);
    }
}

/// Read the tail of the dev agent log for the in-app debug panel. Returns the
/// last `max_bytes` (default 256 KiB), dropping a partial leading line. Empty
/// string when the file doesn't exist yet (no agent calls, or release build).
#[tauri::command]
fn read_dev_log(app: AppHandle, max_bytes: Option<u64>) -> Result<String, String> {
    use std::io::{Read, Seek, SeekFrom};
    let path = dev_log_path(&app);
    let mut file = match std::fs::File::open(&path) {
        Ok(f) => f,
        Err(_) => return Ok(String::new()),
    };
    let max = max_bytes.unwrap_or(256 * 1024);
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    let start = len.saturating_sub(max);
    file.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    let mut s = String::from_utf8_lossy(&buf).into_owned();
    if start > 0 {
        if let Some(idx) = s.find('\n') {
            s = s[idx + 1..].to_string();
        }
    }
    Ok(s)
}

/// Truncate the dev agent log (debug panel "clear" button).
#[tauri::command]
fn clear_dev_log(app: AppHandle) -> Result<(), String> {
    let path = dev_log_path(&app);
    if path.exists() {
        std::fs::write(&path, b"").map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Toggle debug logging (the agent transcript + in-app debug panel). Persists
/// the choice and flips the runtime flag the sidecar checks — no restart needed.
#[tauri::command]
fn set_debug_logging(
    app: AppHandle,
    settings_state: tauri::State<'_, Arc<SettingsState>>,
    enabled: bool,
) -> Result<bool, String> {
    settings_state.set_debug_logging(enabled).map_err(|e| e.to_string())?;
    sync_devlog_flag(&app, enabled);
    Ok(enabled)
}

/// Toggle AI image generation. When off, the illustration pipeline searches for
/// real images only and never generates one.
#[tauri::command]
fn set_image_generation(
    settings_state: tauri::State<'_, Arc<SettingsState>>,
    enabled: bool,
) -> Result<bool, String> {
    settings_state.set_image_generation(enabled).map_err(|e| e.to_string())?;
    Ok(enabled)
}

// ===== Course translation (linked copy in another language) =====

fn copy_dir_all(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_all(&entry.path(), &to)?;
        } else {
            std::fs::copy(entry.path(), &to)?;
        }
    }
    Ok(())
}

/// Translate a batch of short strings via the sidecar; falls back to the
/// originals on any error or length mismatch (never loses content).
fn translate_strings_batch(
    sidecar: &Sidecar,
    backend: &str,
    source_lang: &str,
    target: &str,
    model: &serde_json::Value,
    strings: &[String],
) -> Vec<String> {
    if strings.is_empty() {
        return Vec::new();
    }
    let params = json!({
        "backend": backend,
        "sourceLang": source_lang,
        "targetLang": target,
        "strings": strings,
        "modelConfig": model,
    });
    match sidecar.call("translate_strings", params, Duration::from_secs(900)) {
        Ok(v) => {
            let arr = v
                .get("translations")
                .and_then(|a| a.as_array())
                .cloned()
                .unwrap_or_default();
            if arr.len() == strings.len() {
                arr.iter()
                    .map(|x| x.as_str().unwrap_or("").to_string())
                    .collect()
            } else {
                strings.to_vec()
            }
        }
        Err(_) => strings.to_vec(),
    }
}

/// Create a linked translated copy of a course and translate its content in the
/// background. Returns the new course id immediately.
#[tauri::command]
fn translate_course(
    app: AppHandle,
    db_state: tauri::State<'_, Arc<Db>>,
    paths_state: tauri::State<'_, Arc<AppPaths>>,
    sidecar_state: tauri::State<'_, Arc<Sidecar>>,
    settings_state: tauri::State<'_, Arc<SettingsState>>,
    course_id: String,
    target_language: String,
) -> Result<String, String> {
    let target = target_language.trim().to_string();
    if target.is_empty() {
        return Err("целевой язык обязателен".into());
    }
    let (source, structure) = {
        let conn = db_state.0.lock().map_err(|e| e.to_string())?;
        let c = db::get_course(&conn, &course_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("course not found: {course_id}"))?;
        let s = courses::load_structure(&conn, &course_id).map_err(|e| e.to_string())?;
        (c, s)
    };
    if source.language.trim().eq_ignore_ascii_case(&target) {
        return Err("курс уже на этом языке".into());
    }

    let new_id = Uuid::new_v4().to_string();
    let now = now_unix_secs()?;

    // Remap module/submodule ids (modules.id is a global PK) and record which
    // content dirs to copy.
    let mut copy_jobs: Vec<(String, String, String, String)> = Vec::new();
    let new_modules: Vec<courses::ModuleNode> = structure
        .modules
        .iter()
        .map(|m| {
            let new_mod_id = Uuid::new_v4().to_string();
            let submodules = m
                .submodules
                .iter()
                .map(|s| {
                    let new_sub_id = Uuid::new_v4().to_string();
                    copy_jobs.push((
                        m.id.clone(),
                        s.id.clone(),
                        new_mod_id.clone(),
                        new_sub_id.clone(),
                    ));
                    courses::ModuleNode {
                        id: new_sub_id,
                        title: s.title.clone(),
                        summary: s.summary.clone(),
                        generation_state: s.generation_state.clone(),
                        test_passed: false,
                        test_passed_at: None,
                        prereqs: s.prereqs.clone(),
                        submodules: vec![],
                    }
                })
                .collect();
            courses::ModuleNode {
                id: new_mod_id,
                title: m.title.clone(),
                summary: m.summary.clone(),
                generation_state: m.generation_state.clone(),
                test_passed: false,
                test_passed_at: None,
                prereqs: m.prereqs.clone(),
                submodules,
            }
        })
        .collect();
    let file = courses::StructureFile {
        course_id: new_id.clone(),
        modules: new_modules,
    };

    // Persist the new course + structure rows.
    {
        let conn = db_state.0.lock().map_err(|e| e.to_string())?;
        db::insert_translated_course(&conn, &new_id, &source, &target, now)
            .map_err(|e| e.to_string())?;
        for (mp, m) in file.modules.iter().enumerate() {
            db::insert_module(
                &conn,
                &m.id,
                &new_id,
                None,
                mp as i64,
                &m.title,
                if m.summary.is_empty() { None } else { Some(m.summary.as_str()) },
                &m.generation_state,
            )
            .map_err(|e| e.to_string())?;
            for (sp, s) in m.submodules.iter().enumerate() {
                db::insert_module(
                    &conn,
                    &s.id,
                    &new_id,
                    Some(&m.id),
                    sp as i64,
                    &s.title,
                    if s.summary.is_empty() { None } else { Some(s.summary.as_str()) },
                    &s.generation_state,
                )
                .map_err(|e| e.to_string())?;
                if !s.prereqs.is_empty() {
                    let json = serde_json::to_string(&s.prereqs).unwrap_or_default();
                    db::set_module_prereqs(&conn, &s.id, Some(&json)).map_err(|e| e.to_string())?;
                }
            }
        }
    }

    // Copy files: structure.json, course.md, and each submodule's content dir.
    let src_dir = paths_state.course_dir(&course_id);
    let new_dir = paths_state.course_dir(&new_id);
    std::fs::create_dir_all(&new_dir).map_err(|e| e.to_string())?;
    if let Ok(json) = serde_json::to_string_pretty(&file) {
        let _ = std::fs::write(new_dir.join("structure.json"), json);
    }
    let _ = std::fs::copy(src_dir.join("course.md"), new_dir.join("course.md"));
    for (old_mod, old_sub, new_mod, new_sub) in &copy_jobs {
        let from = courses::submodule_dir(&paths_state, &course_id, old_mod, old_sub);
        if from.is_dir() {
            let to = courses::submodule_dir(&paths_state, &new_id, new_mod, new_sub);
            let _ = copy_dir_all(&from, &to);
        }
    }

    // Translate in the background.
    let db = db_state.inner().clone();
    let paths = paths_state.inner().clone();
    let sidecar = sidecar_state.inner().clone();
    // Tier-route translation through the source course's writing reasoning so a
    // cheap-tier course translates cheaply too.
    let model = apply_tier_reasoning(
        settings_state.stage_model(&source.agent, "writing"),
        &resolve_course_profile(&settings_state, &source),
        "writing",
    );
    let gemini_key = settings_state.gemini_api_key();
    let gemini_model = settings_state.gemini_image_model();
    let image_gen = settings_state.image_generation();
    let app2 = app.clone();
    let new_id_ret = new_id.clone();
    thread::spawn(move || {
        translate_course_content(
            &app2, &db, &paths, &sidecar, source, target, new_id, file, model, gemini_key,
            gemini_model, image_gen,
        );
    });
    Ok(new_id_ret)
}

#[allow(clippy::too_many_arguments)]
fn translate_course_content(
    app: &AppHandle,
    db: &Arc<Db>,
    paths: &Arc<AppPaths>,
    sidecar: &Arc<Sidecar>,
    source: db::Course,
    target: String,
    new_id: String,
    mut file: courses::StructureFile,
    model: serde_json::Value,
    gemini_key: Option<String>,
    gemini_model: String,
    image_gen: bool,
) {
    let backend = source.agent.as_str();
    let src_lang = source.language.as_str();

    // ---- 1. Structure: course title + every module/submodule title & summary.
    let mut strings: Vec<String> = Vec::new();
    if let Some(title) = source.title.as_deref().filter(|t| !t.trim().is_empty()) {
        strings.push(title.to_string());
    }
    for m in &file.modules {
        strings.push(m.title.clone());
        strings.push(m.summary.clone());
        for s in &m.submodules {
            strings.push(s.title.clone());
            strings.push(s.summary.clone());
        }
    }
    let translated = translate_strings_batch(sidecar, backend, src_lang, &target, &model, &strings);
    if translated.len() == strings.len() {
        let mut i = 0;
        let new_title = if source.title.as_deref().map(|t| !t.trim().is_empty()).unwrap_or(false) {
            let t = translated[i].clone();
            i += 1;
            Some(t)
        } else {
            None
        };
        for m in file.modules.iter_mut() {
            m.title = translated[i].clone();
            i += 1;
            m.summary = translated[i].clone();
            i += 1;
            for s in m.submodules.iter_mut() {
                s.title = translated[i].clone();
                i += 1;
                s.summary = translated[i].clone();
                i += 1;
            }
        }
        // Persist translated structure to DB + structure.json.
        if let Ok(conn) = db.0.lock() {
            if let Some(t) = new_title {
                if let Ok(n) = now_unix_secs() {
                    let _ = db::set_course_title(&conn, &new_id, &t, n);
                }
            }
            for m in &file.modules {
                let _ = db::update_module_text(&conn, &m.id, &m.title, &m.summary);
                for s in &m.submodules {
                    let _ = db::update_module_text(&conn, &s.id, &s.title, &s.summary);
                }
            }
        }
        let dir = paths.course_dir(&new_id);
        if let Ok(json) = serde_json::to_string_pretty(&file) {
            let _ = std::fs::write(dir.join("structure.json"), json);
        }
    }
    // ---- 2. Per submodule: article, test, widget captions, image text.
    let subs: Vec<(String, String)> = file
        .modules
        .iter()
        .flat_map(|m| m.submodules.iter().map(move |s| (m.id.clone(), s.id.clone())))
        .collect();
    let total = subs.len();
    // Tell the UI the structure is translated (reload titles live) + show status.
    emit_job_event(
        app,
        &new_id,
        "translate",
        json!({ "ok": false, "phase": "structure", "done": 0, "total": total }),
    );
    for (idx, (mod_id, sub_id)) in subs.iter().enumerate() {
        emit_progress_event(
            app,
            &new_id,
            sub_id,
            "translate",
            &format!("раздел {}/{}", idx + 1, total),
            None,
        );
        let dir = courses::submodule_dir(paths, &new_id, mod_id, sub_id);

        // article.md
        let article_path = dir.join("article.md");
        if let Ok(article) = std::fs::read_to_string(&article_path) {
            if !article.trim().is_empty() {
                let params = json!({
                    "backend": backend,
                    "sourceLang": src_lang,
                    "targetLang": target,
                    "markdown": article,
                    "modelConfig": model,
                });
                if let Ok(v) = sidecar.call("translate_markdown", params, Duration::from_secs(1800)) {
                    if let Some(md) = v.get("markdown").and_then(|x| x.as_str()) {
                        if !md.trim().is_empty() {
                            let _ = std::fs::write(&article_path, md);
                        }
                    }
                }
            }
        }

        // test.json — translate question text + options.
        let test_path = dir.join("test.json");
        if let Ok(s) = std::fs::read_to_string(&test_path) {
            if let Ok(mut test) = serde_json::from_str::<serde_json::Value>(&s) {
                if let Some(arr) = test.as_array_mut() {
                    let mut tstr: Vec<String> = Vec::new();
                    for q in arr.iter() {
                        if let Some(t) = q.get("text").and_then(|v| v.as_str()) {
                            tstr.push(t.to_string());
                        }
                        if let Some(opts) = q.get("options").and_then(|v| v.as_array()) {
                            for o in opts {
                                if let Some(os) = o.as_str() {
                                    tstr.push(os.to_string());
                                }
                            }
                        }
                    }
                    let tt = translate_strings_batch(sidecar, backend, src_lang, &target, &model, &tstr);
                    if tt.len() == tstr.len() {
                        let mut i = 0;
                        for q in arr.iter_mut() {
                            if q.get("text").and_then(|v| v.as_str()).is_some() {
                                q["text"] = json!(tt[i]);
                                i += 1;
                            }
                            if let Some(opts) = q.get_mut("options").and_then(|v| v.as_array_mut()) {
                                for o in opts.iter_mut() {
                                    if o.is_string() {
                                        *o = json!(tt[i]);
                                        i += 1;
                                    }
                                }
                            }
                        }
                        let _ = std::fs::write(&test_path, serde_json::to_string_pretty(&test).unwrap_or(s));
                    }
                }
            }
        }

        // widgets.json — translate captions, then re-generate any AI image whose
        // baked-in text is in the source language.
        let widgets_path = dir.join("widgets.json");
        if let Ok(ws) = std::fs::read_to_string(&widgets_path) {
            if let Ok(mut widgets) = serde_json::from_str::<serde_json::Value>(&ws) {
                const CAPTION_FIELDS: [&str; 7] =
                    ["description", "alt", "caption", "title", "why", "question", "answer"];
                if let Some(obj) = widgets.as_object_mut() {
                    let mut wstr: Vec<String> = Vec::new();
                    let mut collect = |w: &serde_json::Value| {
                        for f in CAPTION_FIELDS {
                            if let Some(s) = w.get(f).and_then(|v| v.as_str()) {
                                if !s.trim().is_empty() {
                                    wstr.push(s.to_string());
                                }
                            }
                        }
                    };
                    for (_k, w) in obj.iter() {
                        collect(w);
                        if let Some(items) = w.get("items").and_then(|v| v.as_array()) {
                            for it in items {
                                collect(it);
                            }
                        }
                    }
                    let wt = translate_strings_batch(sidecar, backend, src_lang, &target, &model, &wstr);
                    if wt.len() == wstr.len() {
                        let mut i = 0;
                        let mut apply = |w: &mut serde_json::Value| {
                            for f in CAPTION_FIELDS {
                                let take = w
                                    .get(f)
                                    .and_then(|v| v.as_str())
                                    .map(|s| !s.trim().is_empty())
                                    .unwrap_or(false);
                                if take {
                                    w[f] = json!(wt[i]);
                                    i += 1;
                                }
                            }
                        };
                        for (_k, w) in obj.iter_mut() {
                            apply(w);
                            if let Some(items) = w.get_mut("items").and_then(|v| v.as_array_mut()) {
                                for it in items.iter_mut() {
                                    apply(it);
                                }
                            }
                        }
                    }
                    // Diagram & interactive widgets carry text the caption pass
                    // doesn't reach: translate the Mermaid labels and the visible
                    // UI text, both with syntax/structure preserved.
                    for (_k, w) in obj.iter_mut() {
                        match w.get("type").and_then(|v| v.as_str()) {
                            Some("diagram") => {
                                let src = w
                                    .get("source")
                                    .and_then(|v| v.as_str())
                                    .map(str::to_string)
                                    .filter(|s| !s.trim().is_empty());
                                if let Some(src) = src {
                                    if let Ok(v) = sidecar.call(
                                        "translate_diagram",
                                        json!({
                                            "backend": backend,
                                            "sourceLang": src_lang,
                                            "targetLang": target,
                                            "source": src,
                                            "modelConfig": model,
                                        }),
                                        Duration::from_secs(600),
                                    ) {
                                        if let Some(tt) = v
                                            .get("source")
                                            .and_then(|x| x.as_str())
                                            .filter(|s| !s.trim().is_empty())
                                        {
                                            w["source"] = json!(tt);
                                        }
                                    }
                                }
                            }
                            Some("interactive") => {
                                let html =
                                    w.get("html").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                let css =
                                    w.get("css").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                let js =
                                    w.get("js").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                if !html.trim().is_empty() || !js.trim().is_empty() {
                                    if let Ok(v) = sidecar.call(
                                        "translate_interactive",
                                        json!({
                                            "backend": backend,
                                            "sourceLang": src_lang,
                                            "targetLang": target,
                                            "html": html,
                                            "css": css,
                                            "js": js,
                                            "modelConfig": model,
                                        }),
                                        Duration::from_secs(600),
                                    ) {
                                        if let Some(tt) = v.get("html").and_then(|x| x.as_str()) {
                                            w["html"] = json!(tt);
                                        }
                                        if let Some(tt) = v.get("css").and_then(|x| x.as_str()) {
                                            w["css"] = json!(tt);
                                        }
                                        if let Some(tt) = v.get("js").and_then(|x| x.as_str()) {
                                            w["js"] = json!(tt);
                                        }
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                }
                let _ = std::fs::write(
                    &widgets_path,
                    serde_json::to_string_pretty(&widgets).unwrap_or_else(|_| ws.clone()),
                );

                // Vision-check generated images; regenerate with translated prompt.
                if image_gen {
                    let mut img_jobs: Vec<(String, String, String)> = Vec::new();
                    let mut collect_img = |w: &serde_json::Value| {
                        if !w.get("generated").and_then(|v| v.as_bool()).unwrap_or(false) {
                            return;
                        }
                        let url = w.get("url").and_then(|v| v.as_str()).unwrap_or("");
                        let path = url.strip_prefix("file://").unwrap_or(url);
                        if !path.starts_with('/') {
                            return;
                        }
                        let desc = w.get("description").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let alt = w.get("alt").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        img_jobs.push((desc, alt, path.to_string()));
                    };
                    if let Some(obj) = widgets.as_object() {
                        for (_k, w) in obj.iter() {
                            match w.get("type").and_then(|v| v.as_str()) {
                                Some("image") => collect_img(w),
                                Some("gallery") => {
                                    if let Some(items) = w.get("items").and_then(|v| v.as_array()) {
                                        for it in items {
                                            collect_img(it);
                                        }
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                    for (desc, alt, path) in img_jobs {
                        let detect = sidecar.call(
                            "detect_image_text_language",
                            json!({
                                "backend": "claude",
                                "imagePath": path,
                                "sourceLang": src_lang,
                                "targetLang": target,
                                "modelConfig": model,
                            }),
                            Duration::from_secs(120),
                        );
                        let should = detect
                            .ok()
                            .and_then(|v| v.get("translate").and_then(|b| b.as_bool()))
                            .unwrap_or(false);
                        if should {
                            if let Some(jpeg) = generate_image_bytes(
                                app, &source, sidecar, sub_id, &desc, &alt, &gemini_key, &gemini_model,
                            ) {
                                let _ = media::save_bytes(&jpeg, std::path::Path::new(&path));
                            }
                        }
                    }
                }
            }
        }

        // assignments.json — translate the homework definition (title/prompt/criteria).
        let assignments_path = dir.join("assignments.json");
        if let Ok(s) = std::fs::read_to_string(&assignments_path) {
            if let Ok(mut assignments) = serde_json::from_str::<serde_json::Value>(&s) {
                const ASSIGN_FIELDS: [&str; 3] = ["title", "prompt", "criteria"];
                if let Some(arr) = assignments.as_array_mut() {
                    let mut astr: Vec<String> = Vec::new();
                    for a in arr.iter() {
                        for f in ASSIGN_FIELDS {
                            if let Some(v) = a.get(f).and_then(|x| x.as_str()) {
                                if !v.trim().is_empty() {
                                    astr.push(v.to_string());
                                }
                            }
                        }
                    }
                    if !astr.is_empty() {
                        let at =
                            translate_strings_batch(sidecar, backend, src_lang, &target, &model, &astr);
                        if at.len() == astr.len() {
                            let mut i = 0;
                            for a in arr.iter_mut() {
                                for f in ASSIGN_FIELDS {
                                    let take = a
                                        .get(f)
                                        .and_then(|x| x.as_str())
                                        .map(|s| !s.trim().is_empty())
                                        .unwrap_or(false);
                                    if take {
                                        a[f] = json!(at[i]);
                                        i += 1;
                                    }
                                }
                            }
                            let _ = std::fs::write(
                                &assignments_path,
                                serde_json::to_string_pretty(&assignments).unwrap_or(s),
                            );
                        }
                    }
                }
            }
        }

        emit_job_event(
            app,
            &new_id,
            "translate",
            json!({ "ok": false, "phase": "submodule", "done": idx + 1, "total": total }),
        );
    }

    emit_job_event(
        app,
        &new_id,
        "translate",
        json!({ "ok": true, "phase": "done", "done": total, "total": total }),
    );
}

/// AI assistant: answer a learner question about the course, grounded in the
/// course program, the current lesson, an optional highlighted fragment, and the
/// space sources. Runs off the main thread.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn ask_course_assistant(
    db_state: tauri::State<'_, Arc<Db>>,
    paths_state: tauri::State<'_, Arc<AppPaths>>,
    sidecar_state: tauri::State<'_, Arc<Sidecar>>,
    settings_state: tauri::State<'_, Arc<SettingsState>>,
    course_id: String,
    module_id: Option<String>,
    submodule_id: Option<String>,
    question: String,
    fragment: Option<String>,
    image_path: Option<String>,
    history: Vec<serde_json::Value>,
) -> Result<String, String> {
    let q = question.trim().to_string();
    if q.is_empty() && image_path.is_none() {
        return Err("вопрос пуст".into());
    }
    let db = db_state.inner().clone();
    let paths = paths_state.inner().clone();
    let sidecar = sidecar_state.inner().clone();
    let settings = settings_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let (course, structure, space) = {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            let c = db::get_course(&conn, &course_id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("course not found: {course_id}"))?;
            let s = courses::load_structure(&conn, &course_id).map_err(|e| e.to_string())?;
            let sp = course_space_context(&paths, &conn, &c);
            (c, s, sp)
        };
        let (docs, links, dirs, strict) = space;
        let article = match (&module_id, &submodule_id) {
            (Some(m), Some(s)) => courses::read_submodule_content(&paths, &course_id, m, s)
                .ok()
                .map(|c| c.article),
            _ => None,
        };
        // Both agents do vision on a local image (Claude via base64, Codex via a
        // local_image input item), so keep the course's own agent.
        let model = settings.stage_model(&course.agent, "writing");
        let params = json!({
            "backend": course.agent,
            "language": course.language,
            "topic": course.topic,
            "structure": structure,
            "article": article,
            "fragment": fragment,
            "imagePath": image_path,
            "question": q,
            "history": history,
            "spaceSources": docs,
            "spaceLinks": links,
            "spaceDirs": dirs,
            "spaceStrict": strict,
            "modelConfig": model,
        });
        let v = sidecar
            .call("course_assistant", params, Duration::from_secs(600))
            .map_err(|e| e.to_string())?;
        Ok(v.get("answer").and_then(|x| x.as_str()).unwrap_or("").to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ===== Local notes (saved assistant chats with an optional fragment anchor) =====

fn notes_path(paths: &AppPaths, course_id: &str) -> PathBuf {
    paths.course_dir(course_id).join("notes.json")
}

fn read_notes(paths: &AppPaths, course_id: &str) -> Vec<serde_json::Value> {
    std::fs::read_to_string(notes_path(paths, course_id))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_notes(paths: &AppPaths, course_id: &str, notes: &[serde_json::Value]) -> Result<(), String> {
    let path = notes_path(paths, course_id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&serde_json::Value::Array(notes.to_vec()))
        .map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_notes(
    paths_state: tauri::State<'_, Arc<AppPaths>>,
    course_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    Ok(read_notes(&paths_state, &course_id))
}

#[tauri::command]
fn save_note(
    paths_state: tauri::State<'_, Arc<AppPaths>>,
    course_id: String,
    note: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let id = note
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "note id required".to_string())?
        .to_string();
    let mut notes = read_notes(&paths_state, &course_id);
    notes.retain(|n| n.get("id").and_then(|v| v.as_str()) != Some(id.as_str()));
    notes.push(note.clone());
    write_notes(&paths_state, &course_id, &notes)?;
    Ok(note)
}

#[tauri::command]
fn delete_note(
    paths_state: tauri::State<'_, Arc<AppPaths>>,
    course_id: String,
    note_id: String,
) -> Result<(), String> {
    let mut notes = read_notes(&paths_state, &course_id);
    notes.retain(|n| n.get("id").and_then(|v| v.as_str()) != Some(note_id.as_str()));
    write_notes(&paths_state, &course_id, &notes)
}

// ===== Per-widget image actions (retry search / pick / generate / remove) =====

#[derive(serde::Serialize)]
struct ImageCandidate {
    url: String,
    source: String,
    title: String,
    thumbnail: String,
}

fn widget_query_fields(widget: &serde_json::Value) -> (String, String, String) {
    let field = |k: &str| {
        widget
            .get(k)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string()
    };
    let description = field("description");
    let prompt = field("prompt");
    let alt = field("alt");
    let query_seed = if !prompt.is_empty() { prompt } else { description.clone() };
    (query_seed, description, alt)
}

/// A short, search-friendly query (Brave rejects very long `q` with HTTP 422).
/// Prefer the short caption/description over the long generation prompt.
fn widget_search_query(widget: &serde_json::Value, topic: &str) -> String {
    let (seed, description, _alt) = widget_query_fields(widget);
    let base = if !description.is_empty() { description } else { seed };
    let query = format!("{base} {topic}");
    query.chars().take(160).collect::<String>().trim().to_string()
}

/// Search for image candidates for one placeholder widget, WITHOUT committing —
/// the user picks one in the UI (which then calls set_widget_image). Runs off
/// the main thread so the UI stays responsive.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn search_widget_candidates(
    app: AppHandle,
    db_state: tauri::State<'_, Arc<Db>>,
    paths_state: tauri::State<'_, Arc<AppPaths>>,
    sidecar_state: tauri::State<'_, Arc<Sidecar>>,
    settings_state: tauri::State<'_, Arc<SettingsState>>,
    course_id: String,
    module_id: String,
    submodule_id: String,
    widget_id: String,
) -> Result<Vec<ImageCandidate>, String> {
    let db = db_state.inner().clone();
    let paths = paths_state.inner().clone();
    let sidecar = sidecar_state.inner().clone();
    let settings = settings_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<ImageCandidate>, String> {
        let course = {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            db::get_course(&conn, &course_id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("course not found: {course_id}"))?
        };
        let content =
            courses::read_submodule_content(&paths, &course_id, &module_id, &submodule_id)
                .map_err(|e| e.to_string())?;
        let widget = content
            .widgets
            .get(&widget_id)
            .cloned()
            .ok_or_else(|| format!("widget not found: {widget_id}"))?;
        let (_seed, description, alt) = widget_query_fields(&widget);
        let query = widget_search_query(&widget, &course.topic);
        if query.is_empty() {
            return Ok(Vec::new());
        }
        let model_config = settings.stage_model(&course.agent, "writing");
        let hits = if let Some(key) = settings.brave_api_key() {
            media::brave_image_search(&key, &query, 12).map_err(|e| e.to_string())?
        } else {
            agent_image_search(
                &app,
                &course,
                &submodule_id,
                &sidecar,
                &description,
                &alt,
                &query,
                &model_config,
            )
            .0
        };
        let mut seen = std::collections::HashSet::<String>::new();
        let candidates = hits
            .into_iter()
            .filter(|h| !h.url.is_empty() && seen.insert(h.url.clone()))
            .map(|h| ImageCandidate {
                url: h.url,
                source: h.source,
                title: h.title,
                thumbnail: h.thumbnail,
            })
            .take(12)
            .collect();
        Ok(candidates)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn update_widget_in_place(
    paths: &AppPaths,
    course_id: &str,
    module_id: &str,
    submodule_id: &str,
    widget_id: &str,
    url: &str,
    source: Option<&str>,
    generated: bool,
) -> Result<(), String> {
    let content = courses::read_submodule_content(paths, course_id, module_id, submodule_id)
        .map_err(|e| e.to_string())?;
    let mut widgets = content.widgets;
    let w = widgets
        .get_mut(widget_id)
        .ok_or_else(|| format!("widget not found: {widget_id}"))?;
    w["url"] = json!(url);
    w["source"] = match source {
        Some(s) if !s.is_empty() => json!(s),
        _ => serde_json::Value::Null,
    };
    w["generated"] = json!(generated);
    courses::write_submodule_widgets(paths, course_id, module_id, submodule_id, &widgets)
        .map_err(|e| e.to_string())
}

/// Download a user-chosen candidate and attach it to the widget. Off-thread.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn set_widget_image(
    paths_state: tauri::State<'_, Arc<AppPaths>>,
    course_id: String,
    module_id: String,
    submodule_id: String,
    widget_id: String,
    url: String,
    source: Option<String>,
) -> Result<(), String> {
    let paths = paths_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let images_dir =
            media::submodule_images_dir(&paths.course_dir(&course_id), &module_id, &submodule_id);
        std::fs::create_dir_all(&images_dir).map_err(|e| e.to_string())?;
        let jpeg = media::download_resize_jpeg(&normalize_wikimedia_thumbnail_url(&url), 2000)
            .map_err(|e| e.to_string())?;
        let final_path = images_dir.join(format!("{widget_id}.jpg"));
        media::save_bytes(&jpeg, &final_path).map_err(|e| e.to_string())?;
        update_widget_in_place(
            &paths,
            &course_id,
            &module_id,
            &submodule_id,
            &widget_id,
            &final_path.to_string_lossy(),
            source.as_deref(),
            false,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Generate an image for the widget (Gemini/Codex) and attach it. Off-thread.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn generate_widget_image(
    app: AppHandle,
    db_state: tauri::State<'_, Arc<Db>>,
    paths_state: tauri::State<'_, Arc<AppPaths>>,
    sidecar_state: tauri::State<'_, Arc<Sidecar>>,
    settings_state: tauri::State<'_, Arc<SettingsState>>,
    course_id: String,
    module_id: String,
    submodule_id: String,
    widget_id: String,
) -> Result<(), String> {
    if !settings_state.image_generation() {
        return Err("генерация изображений отключена в настройках".into());
    }
    let db = db_state.inner().clone();
    let paths = paths_state.inner().clone();
    let sidecar = sidecar_state.inner().clone();
    let gemini_key = settings_state.gemini_api_key();
    let gemini_model = settings_state.gemini_image_model();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let course = {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            db::get_course(&conn, &course_id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("course not found: {course_id}"))?
        };
        let content =
            courses::read_submodule_content(&paths, &course_id, &module_id, &submodule_id)
                .map_err(|e| e.to_string())?;
        let widget = content
            .widgets
            .get(&widget_id)
            .cloned()
            .ok_or_else(|| format!("widget not found: {widget_id}"))?;
        let (seed, description, alt) = widget_query_fields(&widget);
        let desc = if seed.is_empty() { description } else { seed };
        let jpeg = generate_image_bytes(
            &app,
            &course,
            &sidecar,
            &submodule_id,
            &desc,
            &alt,
            &gemini_key,
            &gemini_model,
        )
        .ok_or_else(|| "не удалось сгенерировать изображение".to_string())?;
        let images_dir =
            media::submodule_images_dir(&paths.course_dir(&course_id), &module_id, &submodule_id);
        std::fs::create_dir_all(&images_dir).map_err(|e| e.to_string())?;
        let final_path = images_dir.join(format!("{widget_id}.jpg"));
        media::save_bytes(&jpeg, &final_path).map_err(|e| e.to_string())?;
        update_widget_in_place(
            &paths,
            &course_id,
            &module_id,
            &submodule_id,
            &widget_id,
            &final_path.to_string_lossy(),
            None,
            true,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Remove a widget from the structure: drop it from widgets.json and strip its
/// ::widget marker from the article so no placeholder remains.
#[tauri::command]
fn remove_widget(
    paths_state: tauri::State<'_, Arc<AppPaths>>,
    course_id: String,
    module_id: String,
    submodule_id: String,
    widget_id: String,
) -> Result<(), String> {
    let content = courses::read_submodule_content(&paths_state, &course_id, &module_id, &submodule_id)
        .map_err(|e| e.to_string())?;
    let mut widgets = content.widgets;
    if let Some(obj) = widgets.as_object_mut() {
        obj.remove(&widget_id);
    }
    courses::write_submodule_widgets(&paths_state, &course_id, &module_id, &submodule_id, &widgets)
        .map_err(|e| e.to_string())?;
    let needle = format!("id=\"{widget_id}\"");
    let kept: Vec<&str> = content
        .article
        .lines()
        .filter(|line| {
            let t = line.trim_start();
            !(t.starts_with("::widget{") && t.contains(&needle))
        })
        .collect();
    let new_article = kept.join("\n");
    if new_article != content.article {
        courses::write_submodule_article(&paths_state, &course_id, &module_id, &submodule_id, &new_article)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Whether the agent can generate images for this course (setting on + a model
/// path available: Gemini key, or Codex which has its own image gen).
#[tauri::command]
fn image_generation_available(
    db_state: tauri::State<'_, Arc<Db>>,
    settings_state: tauri::State<'_, Arc<SettingsState>>,
    course_id: String,
) -> Result<bool, String> {
    if !settings_state.image_generation() {
        return Ok(false);
    }
    let conn = db_state.0.lock().map_err(|e| e.to_string())?;
    let course = db::get_course(&conn, &course_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("course not found: {course_id}"))?;
    Ok(settings_state.gemini_api_key().is_some() || course.agent == "codex")
}

// ===== Spaces: knowledge containers + their sources =====

fn classify_source(ext: &str) -> &'static str {
    match ext {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" => "image",
        "csv" | "tsv" | "xlsx" | "xls" => "table",
        _ => "document",
    }
}

/// Convert a document to Markdown. Plain text/markdown is read directly;
/// everything else (PDF, Office, HTML, spreadsheets…) goes through Microsoft's
/// MarkItDown — run via `uvx` so it is fetched on demand if not installed.
fn document_to_markdown(input: &std::path::Path) -> Result<String, String> {
    let ext = input
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if matches!(ext.as_str(), "md" | "markdown" | "txt" | "text") {
        return std::fs::read_to_string(input).map_err(|e| e.to_string());
    }
    let path_env = sidecar::expanded_path();
    let input_arg = input.to_string_lossy().to_string();
    // Prefer a real markitdown on PATH; else uvx auto-fetches it; else a
    // pip-installed module reachable via `python3 -m markitdown`.
    let attempts: [(&str, Vec<String>); 3] = [
        ("markitdown", vec![input_arg.clone()]),
        ("uvx", vec!["markitdown".to_string(), input_arg.clone()]),
        ("python3", vec!["-m".to_string(), "markitdown".to_string(), input_arg.clone()]),
    ];
    let mut last_err = String::new();
    for (cmd, args) in attempts {
        let bin = sidecar::command_path(cmd);
        let out = std::process::Command::new(&bin)
            .args(&args)
            .env("PATH", &path_env)
            .stdin(std::process::Stdio::null())
            .output();
        match out {
            Ok(o) if o.status.success() => {
                let md = String::from_utf8_lossy(&o.stdout).trim().to_string();
                if !md.is_empty() {
                    return Ok(md);
                }
                last_err = format!("{cmd}: produced empty output");
            }
            Ok(o) => {
                last_err = format!("{cmd}: {}", String::from_utf8_lossy(&o.stderr).trim());
            }
            Err(e) => last_err = format!("{cmd}: {e}"),
        }
    }
    Err(format!(
        "не удалось конвертировать в Markdown ({last_err}). Установите MarkItDown: `uv tool install markitdown` или `pipx install markitdown`."
    ))
}

const SPACE_DOC_CHAR_CAP: usize = 24_000;

/// Build the grounding context for a space-scoped course: converted-markdown
/// documents/tables (`spaceSources`) and site/repo links (`spaceLinks`), shaped
/// for the sidecar prompt. Returns empty vecs when the space has no usable
/// content. Each document is capped so one huge PDF can't blow the context.
fn space_context(
    paths: &AppPaths,
    conn: &rusqlite::Connection,
    space_id: &str,
) -> (Vec<serde_json::Value>, Vec<serde_json::Value>, Vec<String>) {
    let mut docs = Vec::new();
    let mut links = Vec::new();
    let mut dirs = Vec::new();
    let Ok(sources) = db::list_space_sources(conn, space_id) else {
        return (docs, links, dirs);
    };
    let dir = paths.space_sources_dir(space_id);
    for s in sources {
        match s.kind.as_str() {
            "site" | "repo" => {
                links.push(json!({ "kind": s.kind, "title": s.title, "url": s.r#ref }));
            }
            // A live directory on disk the agent may read/explore directly.
            "directory" => {
                if std::path::Path::new(&s.r#ref).is_dir() {
                    dirs.push(s.r#ref);
                }
            }
            _ => {
                let Some(md) = s.md_path else { continue };
                let Ok(mut content) = std::fs::read_to_string(dir.join(md)) else {
                    continue;
                };
                if content.trim().is_empty() {
                    continue;
                }
                if content.len() > SPACE_DOC_CHAR_CAP {
                    content.truncate(SPACE_DOC_CHAR_CAP);
                    content.push_str("\n\n…[обрезано]");
                }
                docs.push(json!({ "title": s.title, "kind": s.kind, "content": content }));
            }
        }
    }
    (docs, links, dirs)
}

/// Space grounding for a course: (documents, links, directories, strict). Empty
/// + strict=true when the course isn't scoped to a space.
fn course_space_context(
    paths: &AppPaths,
    conn: &rusqlite::Connection,
    course: &db::Course,
) -> (Vec<serde_json::Value>, Vec<serde_json::Value>, Vec<String>, bool) {
    match course.space_id.as_deref().filter(|s| !s.is_empty()) {
        Some(space_id) => {
            let (docs, links, dirs) = space_context(paths, conn, space_id);
            // Per-course override wins; otherwise inherit the space default.
            let strict = course.strict_sources.unwrap_or_else(|| {
                db::get_space(conn, space_id)
                    .ok()
                    .flatten()
                    .map(|s| s.strict)
                    .unwrap_or(true)
            });
            (docs, links, dirs, strict)
        }
        None => (Vec::new(), Vec::new(), Vec::new(), true),
    }
}

#[derive(serde::Serialize)]
struct MarkitdownStatus {
    available: bool,
    via: String,
}

/// Detect whether document → Markdown conversion can run: a markitdown CLI, uv
/// (which auto-fetches it via uvx), or a pip-installed markitdown module.
fn markitdown_probe() -> MarkitdownStatus {
    if sidecar::command_path_if_found("markitdown").is_some() {
        return MarkitdownStatus { available: true, via: "markitdown".into() };
    }
    if sidecar::command_path_if_found("uvx").is_some()
        || sidecar::command_path_if_found("uv").is_some()
    {
        return MarkitdownStatus { available: true, via: "uvx".into() };
    }
    if sidecar::command_path_if_found("python3").is_some() {
        let ok = std::process::Command::new(sidecar::command_path("python3"))
            .args(["-c", "import markitdown"])
            .env("PATH", sidecar::expanded_path())
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if ok {
            return MarkitdownStatus { available: true, via: "python".into() };
        }
    }
    MarkitdownStatus { available: false, via: String::new() }
}

#[tauri::command]
fn markitdown_status() -> MarkitdownStatus {
    markitdown_probe()
}

/// Install MarkItDown so document conversion works. No-op when `uv` is present
/// (uvx fetches it on demand). Otherwise installs via pipx, `uv tool`, or
/// `pip --user`, whichever is available.
#[tauri::command]
async fn install_markitdown() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(install_markitdown_blocking)
        .await
        .map_err(|e| e.to_string())?
}

fn install_markitdown_blocking() -> Result<String, String> {
    let status = markitdown_probe();
    if status.available {
        return Ok(format!("уже доступен ({})", status.via));
    }
    let path_env = sidecar::expanded_path();
    let (bin, args): (PathBuf, Vec<String>) =
        if let Some(p) = sidecar::command_path_if_found("uv") {
            (p, vec!["tool".into(), "install".into(), "markitdown".into()])
        } else if let Some(p) = sidecar::command_path_if_found("pipx") {
            (p, vec!["install".into(), "markitdown".into()])
        } else if let Some(p) = sidecar::command_path_if_found("python3") {
            (
                p,
                vec![
                    "-m".into(),
                    "pip".into(),
                    "install".into(),
                    "--user".into(),
                    "markitdown".into(),
                ],
            )
        } else {
            return Err(
                "не найдены uv, pipx или python3 — установите Python 3 или uv, затем повторите."
                    .into(),
            );
        };
    let out = std::process::Command::new(&bin)
        .args(&args)
        .env("PATH", &path_env)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(format!(
            "установка не удалась: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

#[tauri::command]
fn list_spaces(db_state: tauri::State<'_, Arc<Db>>) -> Result<Vec<db::Space>, String> {
    let conn = db_state.0.lock().map_err(|e| e.to_string())?;
    db::list_spaces(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_space(
    db_state: tauri::State<'_, Arc<Db>>,
    space_id: String,
) -> Result<Option<db::Space>, String> {
    let conn = db_state.0.lock().map_err(|e| e.to_string())?;
    db::get_space(&conn, &space_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_space(
    db_state: tauri::State<'_, Arc<Db>>,
    name: String,
    description: Option<String>,
) -> Result<db::Space, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("название обязательно".into());
    }
    let id = Uuid::new_v4().to_string();
    let now = now_unix_secs()?;
    let conn = db_state.0.lock().map_err(|e| e.to_string())?;
    db::insert_space(&conn, &id, &name, description.as_deref().unwrap_or("").trim(), now)
        .map_err(|e| e.to_string())?;
    db::get_space(&conn, &id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "space not found after insert".to_string())
}

/// Toggle strict-sources mode for a space. Strict = courses may use ONLY the
/// space's sources; non-strict = sources are the preferred base but can be
/// supplemented.
#[tauri::command]
fn set_space_strict(
    db_state: tauri::State<'_, Arc<Db>>,
    space_id: String,
    strict: bool,
) -> Result<bool, String> {
    let now = now_unix_secs()?;
    let conn = db_state.0.lock().map_err(|e| e.to_string())?;
    db::set_space_strict(&conn, &space_id, strict, now).map_err(|e| e.to_string())?;
    Ok(strict)
}

#[tauri::command]
fn delete_space(
    db_state: tauri::State<'_, Arc<Db>>,
    paths_state: tauri::State<'_, Arc<AppPaths>>,
    space_id: String,
) -> Result<(), String> {
    {
        let conn = db_state.0.lock().map_err(|e| e.to_string())?;
        db::delete_space(&conn, &space_id).map_err(|e| e.to_string())?;
    }
    let _ = std::fs::remove_dir_all(paths_state.space_dir(&space_id));
    Ok(())
}

#[tauri::command]
fn list_space_sources(
    db_state: tauri::State<'_, Arc<Db>>,
    space_id: String,
) -> Result<Vec<db::SpaceSource>, String> {
    let conn = db_state.0.lock().map_err(|e| e.to_string())?;
    db::list_space_sources(&conn, &space_id).map_err(|e| e.to_string())
}

/// Add a site or repository link (kind = "site" | "repo"). No conversion — the
/// agent is told it may use these as allowed sources during research.
#[tauri::command]
fn add_space_link(
    db_state: tauri::State<'_, Arc<Db>>,
    space_id: String,
    url: String,
    title: Option<String>,
    kind: String,
) -> Result<db::SpaceSource, String> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err("ссылка обязательна".into());
    }
    let kind = if kind == "repo" { "repo" } else { "site" };
    let title = title
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| url.clone());
    let id = Uuid::new_v4().to_string();
    let now = now_unix_secs()?;
    let conn = db_state.0.lock().map_err(|e| e.to_string())?;
    db::insert_space_source(&conn, &id, &space_id, kind, &title, &url, "ready", None, now)
        .map_err(|e| e.to_string())?;
    let _ = db::touch_space(&conn, &space_id, now);
    db::get_space_source(&conn, &id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "source not found after insert".to_string())
}

/// Add a local document/image/table. Documents and tables are converted to
/// Markdown (MarkItDown); images are stored as-is. Conversion is blocking, so
/// it runs off the main thread.
#[tauri::command]
async fn add_space_document(
    db_state: tauri::State<'_, Arc<Db>>,
    paths_state: tauri::State<'_, Arc<AppPaths>>,
    space_id: String,
    file_path: String,
) -> Result<db::SpaceSource, String> {
    let db = db_state.inner().clone();
    let paths = paths_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<db::SpaceSource, String> {
    let src = std::path::Path::new(&file_path);
    if !src.is_file() {
        return Err(format!("файл не найден: {file_path}"));
    }
    let orig_name = src
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file")
        .to_string();
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let kind = classify_source(&ext);
    let id = Uuid::new_v4().to_string();
    let now = now_unix_secs()?;

    let dir = paths.space_sources_dir(&space_id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stored = dir.join(if ext.is_empty() {
        id.clone()
    } else {
        format!("{id}.{ext}")
    });
    std::fs::copy(src, &stored).map_err(|e| e.to_string())?;

    let (status, md_path, error): (&str, Option<String>, Option<String>) = if kind == "image" {
        ("ready", None, None)
    } else {
        match document_to_markdown(&stored) {
            Ok(md) => {
                let md_name = format!("{id}.md");
                match std::fs::write(dir.join(&md_name), md) {
                    Ok(()) => ("ready", Some(md_name), None),
                    Err(e) => ("failed", None, Some(e.to_string())),
                }
            }
            Err(e) => ("failed", None, Some(e)),
        }
    };

    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db::insert_space_source(
        &conn,
        &id,
        &space_id,
        kind,
        &orig_name,
        &orig_name,
        status,
        md_path.as_deref(),
        now,
    )
    .map_err(|e| e.to_string())?;
    if let Some(err) = error {
        let _ = db::set_space_source_status(&conn, &id, "failed", None, Some(&err));
    }
    let _ = db::touch_space(&conn, &space_id, now);
    db::get_space_source(&conn, &id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "source not found after insert".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Register a LIVE directory on disk as a space source. Nothing is copied — the
/// path is stored and the agent is granted read access to explore it (read code,
/// list/grep files) while generating a course grounded in the space.
#[tauri::command]
fn add_space_directory(
    db_state: tauri::State<'_, Arc<Db>>,
    space_id: String,
    dir_path: String,
) -> Result<db::SpaceSource, String> {
    let root = std::path::Path::new(&dir_path);
    if !root.is_dir() {
        return Err(format!("папка не найдена: {dir_path}"));
    }
    let canonical = std::fs::canonicalize(root)
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .to_string();
    let title = root
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(&canonical)
        .to_string();
    let id = Uuid::new_v4().to_string();
    let now = now_unix_secs()?;
    let conn = db_state.0.lock().map_err(|e| e.to_string())?;
    db::insert_space_source(
        &conn, &id, &space_id, "directory", &title, &canonical, "ready", None, now,
    )
    .map_err(|e| e.to_string())?;
    let _ = db::touch_space(&conn, &space_id, now);
    db::get_space_source(&conn, &id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "source not found after insert".to_string())
}

#[tauri::command]
fn remove_space_source(
    db_state: tauri::State<'_, Arc<Db>>,
    paths_state: tauri::State<'_, Arc<AppPaths>>,
    source_id: String,
) -> Result<(), String> {
    let conn = db_state.0.lock().map_err(|e| e.to_string())?;
    if let Some(src) = db::get_space_source(&conn, &source_id).map_err(|e| e.to_string())? {
        let dir = paths_state.space_sources_dir(&src.space_id);
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                if name.to_string_lossy().starts_with(&format!("{source_id}.")) {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    }
    db::delete_space_source(&conn, &source_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_space_source_md(
    db_state: tauri::State<'_, Arc<Db>>,
    paths_state: tauri::State<'_, Arc<AppPaths>>,
    source_id: String,
) -> Result<String, String> {
    let conn = db_state.0.lock().map_err(|e| e.to_string())?;
    let src = db::get_space_source(&conn, &source_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "источник не найден".to_string())?;
    let md = src.md_path.ok_or_else(|| "у источника нет markdown".to_string())?;
    let path = paths_state.space_sources_dir(&src.space_id).join(md);
    std::fs::read_to_string(path).map_err(|e| e.to_string())
}

fn crash_log_path() -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    home.join(".learn-anything").join("crash.log")
}

/// Persist every panic (message + location + backtrace) to a crash log. The
/// windowed release build has no console, so a panic during launch — e.g. in
/// the Tauri `setup` hook, which runs inside macOS `applicationDidFinishLaunching`
/// — otherwise aborts with no diagnosable message. This runs the hook BEFORE the
/// abort, so the real cause is always recorded.
fn install_panic_logger() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let payload = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "<non-string panic payload>".to_string());
        let loc = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown>".to_string());
        let bt = std::backtrace::Backtrace::force_capture();
        let entry = format!(
            "\n=== PANIC @ unix {ts} ===\nthread: {}\nlocation: {loc}\nmessage: {payload}\nbacktrace:\n{bt}\n",
            std::thread::current().name().unwrap_or("<unnamed>"),
        );
        let path = crash_log_path();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            use std::io::Write;
            let _ = f.write_all(entry.as_bytes());
        }
        default_hook(info);
    }));
}

/// Reason the agent sidecar isn't running (e.g. Node.js missing), or null when
/// it started normally. The UI shows this so a missing runtime is explained
/// instead of silently failing every generation.
#[tauri::command]
fn sidecar_status(sidecar_state: tauri::State<'_, Arc<Sidecar>>) -> Option<String> {
    sidecar_state.unavailable_reason().map(|s| s.to_string())
}

/// The effective generation profile for a course: its own stored profile if set,
/// otherwise the global default. Blank knobs inside it resolve from the tier
/// preset (see settings.rs), so this is always fully usable.
/// Fill blank `reasoning` in a stage model config from the tier preset (the
/// model name stays the agent default — model routing is unsafe with dynamic
/// CLI catalogs; a user-set reasoning is respected). `stage` is
/// "planning" | "writing" | "tests".
fn apply_tier_reasoning(
    mut model_config: serde_json::Value,
    profile: &GenerationProfile,
    stage: &str,
) -> serde_json::Value {
    let has_reasoning = model_config
        .get("reasoning")
        .and_then(|v| v.as_str())
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    if !has_reasoning {
        if let Some(r) = profile.stage_reasoning(stage) {
            if let serde_json::Value::Object(map) = &mut model_config {
                map.insert("reasoning".to_string(), json!(r));
            }
        }
    }
    model_config
}

/// The genProfile object passed to the sidecar so stages can tune depth,
/// illustration, pedagogy and assessment by tier.
fn gen_profile_json(profile: &GenerationProfile, category: Option<&str>) -> serde_json::Value {
    json!({
        "tier": profile.tier(),
        "pedagogyIntensity": profile.pedagogy_intensity(),
        "researchDepth": profile.research_depth(category),
        "researchMaxTurns": profile.research_max_turns(category),
        "illustrationMode": profile.illustration_mode(),
        "maxTestQuestions": profile.max_test_questions(),
    })
}

fn resolve_course_profile(settings: &SettingsState, course: &db::Course) -> GenerationProfile {
    course
        .generation_profile
        .as_ref()
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_else(|| settings.generation_profile())
}

#[derive(serde::Serialize)]
struct GenEstimate {
    submodules: u32,
    pending: u32,
    low_minutes: u32,
    high_minutes: u32,
}

/// Heuristic wall-clock estimate (minutes) for generating `pending` submodules
/// under a profile. There is no persisted per-stage timing history, so this
/// models the stage set the profile actually runs — draft/review/annotate always,
/// with illustration, tests, assignments and flashcards gated by the profile —
/// and returns an approximate ±range. Presented as "~" in the UI, never exact.
fn estimate_generation_minutes(
    profile: &GenerationProfile,
    category: Option<&str>,
    pending: u32,
) -> (u32, u32) {
    if pending == 0 {
        return (0, 0);
    }
    // Per-submodule seconds, summed across the stages that will run.
    let draft: u32 = match profile.stage_reasoning("writing") {
        Some("high") | Some("xhigh") | Some("max") => 120,
        Some("low") | Some("off") => 55,
        _ => 80,
    };
    let research: u32 = match profile.research_max_turns(category) {
        t if t >= 16 => 50,
        t if t >= 10 => 20,
        _ => 5,
    };
    let mut per: u32 = draft + research + 40 /* review */ + 30 /* annotate */;
    match profile.illustration_mode().as_str() {
        "off" => {}
        "full" => per += 90,
        _ => per += 55,
    }
    if !profile.skip_tests() {
        per += 40;
    }
    if !profile.skip_assignments() {
        per += 55;
    }
    if profile.pedagogy_intensity() != "lean" {
        per += 30; // flashcards
    }
    let total = (per.saturating_mul(pending)) as f64;
    let low = ((total * 0.7) / 60.0).ceil() as u32;
    let high = ((total * 1.4) / 60.0).ceil() as u32;
    (low.max(1), high.max(low.max(1)))
}

#[tauri::command]
fn estimate_course_generation(
    db_state: tauri::State<'_, Arc<Db>>,
    settings_state: tauri::State<'_, Arc<SettingsState>>,
    course_id: String,
) -> Result<GenEstimate, String> {
    let (course, structure) = {
        let conn = db_state.0.lock().map_err(|e| e.to_string())?;
        let course = db::get_course(&conn, &course_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("course not found: {course_id}"))?;
        let structure = courses::load_structure(&conn, &course_id).map_err(|e| e.to_string())?;
        (course, structure)
    };
    let mut submodules = 0u32;
    let mut pending = 0u32;
    for m in &structure.modules {
        for s in &m.submodules {
            submodules += 1;
            if s.generation_state != "ready" {
                pending += 1;
            }
        }
    }
    let profile = resolve_course_profile(&settings_state, &course);
    let (low, high) = estimate_generation_minutes(&profile, course.category.as_deref(), pending);
    Ok(GenEstimate {
        submodules,
        pending,
        low_minutes: low,
        high_minutes: high,
    })
}

#[tauri::command]
fn get_course_profile(
    db_state: tauri::State<'_, Arc<Db>>,
    settings_state: tauri::State<'_, Arc<SettingsState>>,
    course_id: String,
) -> Result<GenerationProfile, String> {
    let course = {
        let conn = db_state.0.lock().map_err(|e| e.to_string())?;
        db::get_course(&conn, &course_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("course not found: {course_id}"))?
    };
    Ok(resolve_course_profile(&settings_state, &course))
}

#[tauri::command]
fn set_course_profile(
    db_state: tauri::State<'_, Arc<Db>>,
    course_id: String,
    profile: GenerationProfile,
) -> Result<(), String> {
    let json = serde_json::to_string(&profile).map_err(|e| e.to_string())?;
    let conn = db_state.0.lock().map_err(|e| e.to_string())?;
    db::set_course_generation_profile(&conn, &course_id, Some(&json)).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_panic_logger();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
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
                spaces_root: dir.join("spaces"),
            }));

            let settings = Arc::new(SettingsState::load(dir.clone()));
            // Reflect the persisted debug-logging choice into the runtime flag
            // the sidecar checks (defaults to on in dev builds).
            sync_devlog_flag(&app.handle(), settings.debug_logging());
            app.manage(settings);

            // A failed sidecar (e.g. Node.js not installed) must NOT abort
            // launch — start in a "dead" state so the window opens and the UI
            // can explain why generation won't work.
            let sidecar = Sidecar::spawn(&sidecar_script_path(&app.handle()), &dir)
                .unwrap_or_else(|e| {
                    eprintln!("[startup] sidecar unavailable: {e}");
                    Sidecar::dead(e.to_string())
                });
            app.manage(Arc::new(sidecar));

            app.manage(Arc::new(ShareState::new()));
            share::start_http_server(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_courses,
            create_course,
            set_course_agent,
            sidecar_status,
            get_course_profile,
            set_course_profile,
            sidecar_call,
            start_course_suggestion,
            get_wizard_dialog,
            save_wizard_answers,
            wizard_next_question,
            start_build_structure,
            get_structure,
            save_structure,
            list_chat,
            start_structure_refine,
            accept_structure_refinement,
            start_generate_submodule,
            start_first_pending_submodule,
            start_full_course_generation,
            translate_course,
            ask_course_assistant,
            list_notes,
            save_note,
            delete_note,
            read_submodule_article,
            read_submodule_error,
            submit_test_result,
            get_due_reviews,
            due_review_counts,
            grade_review,
            get_assignments,
            submit_assignment,
            start_generate_assignments,
            start_generate_flashcards,
            estimate_course_generation,
            start_illustrate_submodule,
            delete_course,
            get_settings_status,
            set_brave_key,
            set_gemini_key,
            set_catalog_upload_token,
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
            list_catalog_courses,
            publish_course_to_catalog,
            download_catalog_course,
            get_catalog_update,
            update_catalog_course,
            get_model_settings,
            set_model_settings,
            read_dev_log,
            clear_dev_log,
            set_debug_logging,
            set_image_generation,
            search_widget_candidates,
            set_widget_image,
            generate_widget_image,
            remove_widget,
            image_generation_available,
            list_spaces,
            get_space,
            create_space,
            set_space_strict,
            delete_space,
            list_space_sources,
            add_space_link,
            add_space_document,
            add_space_directory,
            remove_space_source,
            read_space_source_md,
            markitdown_status,
            install_markitdown
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

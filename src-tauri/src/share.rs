// Remote sharing: an embedded HTTP server that mirrors the Tauri command API
// over plain JSON so a phone/tablet can drive the app through an ngrok tunnel.
//
// The desktop webview keeps talking over Tauri IPC; the browser client talks to
// /api/cmd/<name> (command dispatch), /api/events (long-poll for job/stage
// events), and /media (widget images). ngrok publishes the local port.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tiny_http::{Header, Method, Response, Server};

use crate::courses::AppPaths;
use crate::events::event_hub;

pub const SHARE_PORT: u16 = 8787;

#[derive(Default)]
pub struct ShareState {
    inner: Mutex<ShareInner>,
}

#[derive(Default)]
struct ShareInner {
    child: Option<Child>,
    url: Option<String>,
}

impl ShareState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn url(&self) -> Option<String> {
        self.inner.lock().unwrap().url.clone()
    }
}

#[derive(Serialize)]
pub struct ShareInfo {
    pub url: Option<String>,
    pub port: u16,
}

/// Start ngrok against the local HTTP port and return its public URL. Idempotent:
/// returns the existing URL if already sharing. When `domain` is given, ngrok
/// binds that reserved endpoint instead of a random one.
pub fn start_ngrok(state: &ShareState, domain: Option<&str>) -> Result<String, String> {
    {
        let inner = state.inner.lock().unwrap();
        if let Some(url) = &inner.url {
            return Ok(url.clone());
        }
    }
    let mut args = vec![
        "http".to_string(),
        SHARE_PORT.to_string(),
        "--log".to_string(),
        "stdout".to_string(),
    ];
    if let Some(d) = domain.map(str::trim).filter(|d| !d.is_empty()) {
        // ngrok wants a full URL; accept a bare hostname too.
        let url = if d.contains("://") {
            d.to_string()
        } else {
            format!("https://{d}")
        };
        args.push("--url".to_string());
        args.push(url);
    }
    let ngrok_path = crate::sidecar::command_path("ngrok");
    let child = Command::new(&ngrok_path)
        .args(&args)
        .env("PATH", crate::sidecar::expanded_path())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to start ngrok at {}: {e}", ngrok_path.display()))?;
    state.inner.lock().unwrap().child = Some(child);

    let url = poll_ngrok_url()?;
    state.inner.lock().unwrap().url = Some(url.clone());
    Ok(url)
}

pub fn stop_ngrok(state: &ShareState) {
    let mut inner = state.inner.lock().unwrap();
    if let Some(mut child) = inner.child.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    inner.url = None;
}

// ngrok exposes a local API listing active tunnels. Poll it until the public
// HTTPS URL appears (the agent takes a moment to register).
fn poll_ngrok_url() -> Result<String, String> {
    for _ in 0..60 {
        if let Ok(resp) = ureq::get("http://127.0.0.1:4040/api/tunnels").call() {
            if let Ok(v) = resp.into_json::<Value>() {
                if let Some(tunnels) = v.get("tunnels").and_then(|t| t.as_array()) {
                    let https = tunnels.iter().find_map(|t| {
                        t.get("public_url")
                            .and_then(|u| u.as_str())
                            .filter(|u| u.starts_with("https"))
                    });
                    if let Some(u) = https {
                        return Ok(u.to_string());
                    }
                    if let Some(u) = tunnels
                        .first()
                        .and_then(|t| t.get("public_url"))
                        .and_then(|u| u.as_str())
                    {
                        return Ok(u.to_string());
                    }
                }
            }
        }
        thread::sleep(Duration::from_millis(250));
    }
    Err("ngrok started but no tunnel appeared — check that an authtoken is configured (ngrok config add-authtoken ...)".into())
}

/// Bind the local HTTP server and serve requests on a background thread.
pub fn start_http_server(app: AppHandle) {
    let server = match Server::http(("127.0.0.1", SHARE_PORT)) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[share] failed to bind 127.0.0.1:{SHARE_PORT}: {e}");
            return;
        }
    };
    eprintln!("[share] http server listening on http://127.0.0.1:{SHARE_PORT}");
    thread::spawn(move || {
        for request in server.incoming_requests() {
            let app = app.clone();
            // Long-poll requests block; handle each on its own thread.
            thread::spawn(move || handle(&app, request));
        }
    });
}

fn handle(app: &AppHandle, mut request: tiny_http::Request) {
    let url = request.url().to_string();
    let (path, query) = match url.split_once('?') {
        Some((p, q)) => (p, q),
        None => (url.as_str(), ""),
    };
    let method = request.method().clone();

    if method == Method::Post && path.starts_with("/api/cmd/") {
        let name = path.trim_start_matches("/api/cmd/").to_string();
        let mut body = String::new();
        if request.as_reader().read_to_string(&mut body).is_err() {
            respond_text(request, 400, "could not read body");
            return;
        }
        let args: Value = if body.trim().is_empty() {
            json!({})
        } else {
            match serde_json::from_str(&body) {
                Ok(v) => v,
                Err(e) => {
                    respond_text(request, 400, &format!("bad json: {e}"));
                    return;
                }
            }
        };
        match dispatch(app, &name, &args) {
            Ok(v) => respond_json(request, 200, &v),
            Err(e) => respond_text(request, 400, &e),
        }
        return;
    }

    if method == Method::Get && path == "/api/events" {
        let since = query_param(query, "since")
            .and_then(|s| s.parse::<u64>().ok());
        let hub = event_hub();
        let (events, cursor) = match since {
            Some(s) => hub.since(s),
            None => (Vec::new(), hub.cursor()),
        };
        respond_json(request, 200, &json!({ "events": events, "cursor": cursor }));
        return;
    }

    if method == Method::Get && path == "/media" {
        match query_param(query, "path") {
            Some(p) => serve_media(app, request, &p),
            None => respond_text(request, 400, "missing path"),
        }
        return;
    }

    if method == Method::Get && path == "/yt" {
        match query_param(query, "src") {
            Some(src) => serve_youtube_embed(request, &src),
            None => respond_text(request, 400, "missing src"),
        }
        return;
    }

    if method == Method::Get {
        serve_static(app, request, path);
        return;
    }

    respond_text(request, 404, "not found");
}

// Wrap a YouTube/Vimeo embed in a page served from this http origin so the
// player receives a valid HTTP Referer. In production the app is served from the
// `tauri://localhost` custom scheme, whose origin YouTube rejects with "Error
// 153"; loading the embed inside an iframe hosted here (origin http://127.0.0.1)
// gives the player the http referer it requires. `src` is validated against a
// fixed allow-list and rejected if it carries characters that could break out of
// the attribute, so the reflection into HTML is safe.
fn serve_youtube_embed(request: tiny_http::Request, src: &str) {
    const ALLOWED: [&str; 3] = [
        "https://www.youtube.com/embed/",
        "https://www.youtube-nocookie.com/embed/",
        "https://player.vimeo.com/video/",
    ];
    let safe =
        ALLOWED.iter().any(|p| src.starts_with(p)) && !src.contains(['"', '\'', '<', '>', ' ']);
    if !safe {
        respond_text(request, 400, "unsupported embed url");
        return;
    }
    let html = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\">\
<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
<meta name=\"referrer\" content=\"strict-origin-when-cross-origin\">\
<style>html,body{{margin:0;height:100%;background:#000;overflow:hidden}}\
iframe{{position:fixed;inset:0;width:100%;height:100%;border:0}}</style></head>\
<body><iframe src=\"{src}\" \
allow=\"accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture\" \
allowfullscreen></iframe></body></html>"
    );
    let resp =
        Response::from_string(html).with_header(header("Content-Type", "text/html; charset=utf-8"));
    let _ = request.respond(resp);
}

// Dispatch a command name to the matching Tauri command, pulling managed state
// off the AppHandle exactly as the IPC layer would.
fn dispatch(app: &AppHandle, name: &str, a: &Value) -> Result<Value, String> {
    let s = |k: &str| a.get(k).and_then(|v| v.as_str()).map(|x| x.to_string());
    let req = |k: &str| s(k).ok_or_else(|| format!("missing arg: {k}"));

    match name {
        "list_courses" => to_val(crate::list_courses(app.state())?),
        "create_course" => to_val(crate::create_course(
            app.state(),
            req("topic")?,
            req("language")?,
            s("courseFormat").or_else(|| s("course_format")),
            s("agent"),
            s("spaceId").or_else(|| s("space_id")),
            None,
            s("roadmapId").or_else(|| s("roadmap_id")),
            s("roadmapSkill").or_else(|| s("roadmap_skill")),
        )?),
        "set_course_agent" => {
            crate::set_course_agent(app.state(), req("courseId")?, req("agent")?)?;
            Ok(Value::Null)
        }
        "set_course_tags" => to_val(crate::set_course_tags(
            app.state(),
            req("courseId")?,
            from_arg(a, "tags", json!([]))?,
        )?),
        "get_settings_status" => to_val(crate::get_settings_status(app.state())),
        "check_agent_availability" => to_val(crate::check_agent_availability(app.state())),
        "set_brave_key" => to_val(crate::set_brave_key(app.state(), s("key"))?),
        "set_gemini_key" => to_val(crate::set_gemini_key(app.state(), s("key"))?),
        "set_catalog_upload_token" => {
            to_val(crate::set_catalog_upload_token(app.state(), s("token"))?)
        }
        "set_tts_engine" => to_val(crate::set_tts_engine(app.state(), s("engine"))?),
        "set_tts_voice" => to_val(crate::set_tts_voice(app.state(), s("voice"))?),
        "set_gemini_image_model" => {
            to_val(crate::set_gemini_image_model(app.state(), s("model"))?)
        }
        "set_gemini_tts_model" => to_val(crate::set_gemini_tts_model(app.state(), s("model"))?),
        "list_gemini_models" => {
            Ok(tauri::async_runtime::block_on(crate::list_gemini_models(app.state()))?)
        }
        "synthesize_speech" => to_val(tauri::async_runtime::block_on(crate::synthesize_speech(
            app.state(),
            req("text")?,
        ))?),
        "get_model_settings" => to_val(crate::get_model_settings(app.state())),
        "set_model_settings" => to_val(crate::set_model_settings(
            app.state(),
            from_arg(a, "models", json!({}))?,
        )?),
        "list_catalog_courses" => to_val(tauri::async_runtime::block_on(
            crate::list_catalog_courses(
                app.state(),
                s("query"),
                s("serverId").or_else(|| s("server_id")),
            ),
        )?),
        "publish_course_to_catalog" => to_val(tauri::async_runtime::block_on(
            crate::publish_course_to_catalog(
                app.state(),
                app.state(),
                app.state(),
                req("courseId")?,
                s("serverId").or_else(|| s("server_id")),
            ),
        )?),
        "download_catalog_course" => to_val(tauri::async_runtime::block_on(
            crate::download_catalog_course(
                app.state(),
                app.state(),
                app.state(),
                req("catalogId")?,
                s("serverId").or_else(|| s("server_id")),
            ),
        )?),
        "get_catalog_update" => to_val(tauri::async_runtime::block_on(crate::get_catalog_update(
            app.state(),
            req("courseId")?,
        ))?),
        "update_catalog_course" => to_val(crate::update_catalog_course(
            app.state(),
            app.state(),
            req("courseId")?,
        )?),
        "get_structure" => to_val(crate::get_structure(app.state(), req("courseId")?)?),
        "list_chat" => to_val(crate::list_chat(app.state(), req("courseId")?)?),
        "save_wizard_answers" => {
            crate::save_wizard_answers(
                app.state(),
                app.state(),
                req("courseId")?,
                from_arg(a, "answers", json!([]))?,
            )?;
            Ok(Value::Null)
        }
        "get_wizard_dialog" => to_val(crate::get_wizard_dialog(
            app.state(),
            req("courseId")?,
        )?),
        "save_structure" => to_val(crate::save_structure(
            app.state(),
            app.state(),
            req("courseId")?,
            from_arg(a, "modules", json!([]))?,
        )?),
        "save_lesson_content" => {
            crate::save_lesson_content(
                app.clone(),
                app.state(),
                app.state(),
                req("courseId")?,
                req("moduleId")?,
                req("submoduleId")?,
                req("article")?,
                from_arg(a, "widgets", json!({}))?,
                a.get("markReady").and_then(|v| v.as_bool()).unwrap_or(false),
            )?;
            Ok(Value::Null)
        }
        "edit_text" => to_val(tauri::async_runtime::block_on(crate::edit_text(
            app.state(),
            app.state(),
            app.state(),
            req("courseId")?,
            req("selection")?,
            req("instruction")?,
            s("context"),
        ))?),
        "read_submodule_article" => to_val(crate::read_submodule_article(
            app.state(),
            req("courseId")?,
            req("moduleId")?,
            req("submoduleId")?,
        )?),
        "read_submodule_error" => to_val(crate::read_submodule_error(
            app.state(),
            req("courseId")?,
            req("moduleId")?,
            req("submoduleId")?,
        )),
        "accept_structure_refinement" => to_val(crate::accept_structure_refinement(
            app.state(),
            app.state(),
            req("courseId")?,
            req("messageId")?,
        )?),
        "submit_test_result" => {
            let passed = a.get("passed").and_then(|v| v.as_bool()).unwrap_or(false);
            let ratio = a
                .get("ratio")
                .and_then(|v| v.as_f64())
                .unwrap_or(if passed { 1.0 } else { 0.0 });
            let results = a
                .get("results")
                .and_then(|v| v.as_array())
                .map(|arr| arr.iter().map(|x| x.as_bool().unwrap_or(false)).collect::<Vec<bool>>())
                .unwrap_or_default();
            let weak_concepts = a
                .get("weakConcepts")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|x| x.as_str().map(|s| s.to_string()))
                        .collect::<Vec<String>>()
                });
            crate::submit_test_result(
                app.state(),
                app.state(),
                req("submoduleId")?,
                ratio,
                results,
                passed,
                weak_concepts,
            )?;
            Ok(Value::Null)
        }
        "delete_course" => {
            crate::delete_course(app.state(), app.state(), req("courseId")?)?;
            Ok(Value::Null)
        }
        "wizard_next_question" => to_val(tauri::async_runtime::block_on(crate::wizard_next_question(
            app.state(),
            app.state(),
            app.state(),
            app.state(),
            req("courseId")?,
            from_arg(a, "answered", json!([]))?,
        ))?),
        "list_roadmaps" => to_val(crate::list_roadmaps(app.state())?),
        "get_roadmap" => to_val(crate::get_roadmap(app.state(), req("roadmapId")?)?),
        "create_roadmap" => to_val(crate::create_roadmap(
            app.state(),
            req("topic")?,
            req("language")?,
            s("agent"),
        )?),
        "delete_roadmap" => {
            crate::delete_roadmap(app.state(), req("roadmapId")?)?;
            Ok(Value::Null)
        }
        "set_roadmap_tags" => to_val(crate::set_roadmap_tags(
            app.state(),
            req("roadmapId")?,
            from_arg(a, "tags", json!([]))?,
        )?),
        "roadmap_wizard_next_question" => to_val(tauri::async_runtime::block_on(
            crate::roadmap_wizard_next_question(
                app.state(),
                app.state(),
                app.state(),
                req("roadmapId")?,
                from_arg(a, "answered", json!([]))?,
            ),
        )?),
        "get_roadmap_wizard_dialog" => to_val(crate::get_roadmap_wizard_dialog(
            app.state(),
            req("roadmapId")?,
        )?),
        "save_roadmap_wizard_answers" => {
            crate::save_roadmap_wizard_answers(
                app.clone(),
                app.state(),
                app.state(),
                app.state(),
                req("roadmapId")?,
                from_arg(a, "answers", json!([]))?,
            )?;
            Ok(Value::Null)
        }
        "start_build_roadmap" => {
            crate::start_build_roadmap(
                app.clone(),
                app.state(),
                app.state(),
                app.state(),
                req("roadmapId")?,
            )?;
            Ok(Value::Null)
        }
        "set_skill_done" => {
            crate::set_skill_done(
                app.state(),
                req("roadmapId")?,
                req("skillId")?,
                a.get("done").and_then(|v| v.as_bool()).unwrap_or(true),
            )?;
            Ok(Value::Null)
        }
        "link_course_to_skill" => {
            crate::link_course_to_skill(
                app.state(),
                req("courseId")?,
                s("roadmapId").or_else(|| s("roadmap_id")),
                s("roadmapSkill").or_else(|| s("roadmap_skill")),
            )?;
            Ok(Value::Null)
        }
        "roadmap_node_quiz" => to_val(tauri::async_runtime::block_on(crate::roadmap_node_quiz(
            app.state(),
            app.state(),
            app.state(),
            req("roadmapId")?,
            req("nodeId")?,
        ))?),
        "get_roadmap_chat" => to_val(crate::get_roadmap_chat(app.state(), req("roadmapId")?)?),
        "start_roadmap_refine" => {
            crate::start_roadmap_refine(
                app.clone(),
                app.state(),
                app.state(),
                app.state(),
                req("roadmapId")?,
                req("userMessage")?,
            )?;
            Ok(Value::Null)
        }
        "accept_roadmap_refinement" => to_val(crate::accept_roadmap_refinement(
            app.state(),
            req("roadmapId")?,
            req("messageId")?,
        )?),
        "start_course_suggestion" => {
            crate::start_course_suggestion(
                app.clone(),
                app.state(),
                app.state(),
                app.state(),
                s("backend"),
                req("language")?,
            )?;
            Ok(Value::Null)
        }
        "start_build_structure" => {
            crate::start_build_structure(
                app.clone(),
                app.state(),
                app.state(),
                app.state(),
                app.state(),
                req("courseId")?,
            )?;
            Ok(Value::Null)
        }
        "start_structure_refine" => {
            crate::start_structure_refine(
                app.clone(),
                app.state(),
                app.state(),
                app.state(),
                app.state(),
                req("courseId")?,
                req("userMessage")?,
            )?;
            Ok(Value::Null)
        }
        "start_generate_submodule" => {
            crate::start_generate_submodule(
                app.clone(),
                app.state(),
                app.state(),
                app.state(),
                app.state(),
                req("courseId")?,
                req("submoduleId")?,
                None,
                None,
                None,
            )?;
            Ok(Value::Null)
        }
        "start_first_pending_submodule" => to_val(crate::start_first_pending_submodule(
            app.clone(),
            app.state(),
            app.state(),
            app.state(),
            app.state(),
            req("courseId")?,
        )?),
        "start_full_course_generation" => to_val(crate::start_full_course_generation(
            app.clone(),
            app.state(),
            app.state(),
            app.state(),
            app.state(),
            req("courseId")?,
        )?),
        "sidecar_call" => to_val(crate::sidecar_call(
            app.state(),
            req("method")?,
            a.get("params").cloned().unwrap_or(json!({})),
        )?),
        "get_assignments" => to_val(crate::get_assignments(
            app.state(),
            req("courseId")?,
            req("moduleId")?,
            req("submoduleId")?,
        )?),
        "submit_assignment" => to_val(crate::submit_assignment(
            app.clone(),
            app.state(),
            app.state(),
            app.state(),
            app.state(),
            req("courseId")?,
            req("moduleId")?,
            req("submoduleId")?,
            req("assignmentId")?,
            req("submissionType")?,
            s("text"),
            s("githubUrl"),
            from_arg(a, "files", json!([]))?,
            s("code"),
        )?),
        "start_generate_assignments" => {
            crate::start_generate_assignments(
                app.clone(),
                app.state(),
                app.state(),
                app.state(),
                app.state(),
                req("courseId")?,
                req("moduleId")?,
                req("submoduleId")?,
            )?;
            Ok(Value::Null)
        }
        "start_illustrate_submodule" => {
            crate::start_illustrate_submodule(
                app.clone(),
                app.state(),
                app.state(),
                app.state(),
                app.state(),
                req("courseId")?,
                req("moduleId")?,
                req("submoduleId")?,
            )?;
            Ok(Value::Null)
        }
        _ => Err(format!("unknown command: {name}")),
    }
}

fn to_val<T: Serialize>(v: T) -> Result<Value, String> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}

fn from_arg<T: serde::de::DeserializeOwned>(
    a: &Value,
    key: &str,
    default: Value,
) -> Result<T, String> {
    serde_json::from_value(a.get(key).cloned().unwrap_or(default)).map_err(|e| e.to_string())
}

// Serve a widget image. Only files under the courses root are allowed — this
// endpoint is reachable over the public tunnel.
fn serve_media(app: &AppHandle, request: tiny_http::Request, raw_path: &str) {
    let paths = app.state::<Arc<AppPaths>>();
    let root = match paths.courses_root.canonicalize() {
        Ok(r) => r,
        Err(_) => {
            respond_text(request, 404, "no courses dir");
            return;
        }
    };
    let requested = PathBuf::from(raw_path);
    let canon = match requested.canonicalize() {
        Ok(c) => c,
        Err(_) => {
            respond_text(request, 404, "not found");
            return;
        }
    };
    if !canon.starts_with(&root) {
        respond_text(request, 403, "forbidden");
        return;
    }
    match std::fs::read(&canon) {
        Ok(bytes) => {
            let ct = content_type(canon.extension().and_then(|e| e.to_str()).unwrap_or(""));
            let resp = Response::from_data(bytes).with_header(header("Content-Type", ct));
            let _ = request.respond(resp);
        }
        Err(_) => respond_text(request, 404, "not found"),
    }
}

// Serve the built SPA, falling back to index.html for client routes.
fn serve_static(app: &AppHandle, request: tiny_http::Request, path: &str) {
    let rel = path.trim_start_matches('/');
    if rel.contains("..") {
        respond_text(request, 403, "forbidden");
        return;
    }
    if !rel.is_empty() {
        if let Some(bytes) = read_direct_static_asset(app, rel) {
            let ct = content_type(Path::new(rel).extension().and_then(|e| e.to_str()).unwrap_or(""));
            let resp = Response::from_data(bytes).with_header(header("Content-Type", ct));
            let _ = request.respond(resp);
            return;
        }
        // A missing file with an extension is a real asset (JS/CSS/font), not a
        // client route. Return 404 — never fall back to index.html, or the
        // browser rejects HTML served as a module ("incorrect MIME type"),
        // which is what breaks Mermaid's lazily-imported chunks on iPad Safari.
        let looks_like_file = rel
            .rsplit('/')
            .next()
            .map(|seg| seg.contains('.'))
            .unwrap_or(false);
        if looks_like_file {
            respond_text(request, 404, "not found");
            return;
        }
    }
    // SPA shell for "/" and extensionless client routes. no-cache so a stale
    // index.html can't keep pointing at chunk hashes that no longer exist.
    match read_index_asset(app) {
        Some(bytes) => {
            let resp = Response::from_data(bytes)
                .with_header(header("Content-Type", "text/html; charset=utf-8"))
                .with_header(header("Cache-Control", "no-cache"));
            let _ = request.respond(resp);
        }
        None => respond_text(request, 404, "frontend assets unavailable"),
    }
}

fn read_direct_static_asset(app: &AppHandle, rel: &str) -> Option<Vec<u8>> {
    if embedded_asset_exists(app, rel) {
        return app.asset_resolver().get(rel.to_string()).map(|asset| asset.bytes);
    }
    std::fs::read(dist_dir().join(rel)).ok()
}

fn read_index_asset(app: &AppHandle) -> Option<Vec<u8>> {
    app.asset_resolver()
        .get("index.html".to_string())
        .map(|asset| asset.bytes)
        .or_else(|| std::fs::read(dist_dir().join("index.html")).ok())
}

fn embedded_asset_exists(app: &AppHandle, rel: &str) -> bool {
    app.asset_resolver()
        .iter()
        .any(|(asset_path, _)| asset_path.as_ref().trim_start_matches('/') == rel)
}

fn dist_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri has a parent")
        .join("dist")
}

fn content_type(ext: &str) -> &'static str {
    match ext {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        _ => "application/octet-stream",
    }
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("valid header")
}

fn respond_json(request: tiny_http::Request, status: u16, value: &Value) {
    let body = serde_json::to_string(value).unwrap_or_else(|_| "null".to_string());
    let resp = Response::from_string(body)
        .with_status_code(status)
        .with_header(header("Content-Type", "application/json"));
    let _ = request.respond(resp);
}

fn respond_text(request: tiny_http::Request, status: u16, text: &str) {
    let resp = Response::from_string(text.to_string()).with_status_code(status);
    let _ = request.respond(resp);
}

fn query_param(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        if k == key {
            urlencoding::decode(v).ok().map(|c| c.into_owned())
        } else {
            None
        }
    })
}

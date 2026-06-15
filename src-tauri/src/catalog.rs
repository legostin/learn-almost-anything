use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::courses::{self, AppPaths};
use crate::db;

pub const DEFAULT_CATALOG_URL: &str = "https://catalog.almost-anything.io";
const SCHEMA_VERSION: u32 = 1;
const FILE_REF_PREFIX: &str = "laa://file/";

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CatalogCourseMeta {
    pub id: String,
    pub topic: String,
    pub title: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub language: String,
    #[serde(default = "default_course_format")]
    pub course_format: String,
    pub agent: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub catalog_origin_id: Option<String>,
    #[serde(default)]
    pub catalog_version: i64,
}

fn default_course_format() -> String {
    db::DEFAULT_COURSE_FORMAT.to_string()
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CatalogSubmodulePackage {
    pub module_id: String,
    pub submodule_id: String,
    pub article: String,
    pub widgets: Value,
    pub sources: Value,
    pub test: Value,
    pub review_notes: String,
    pub assignments: Value,
    /// Added after schema 1 shipped — defaulted so older packages still parse.
    #[serde(default)]
    pub flashcards: Value,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CatalogFilePackage {
    pub path: String,
    pub media_type: String,
    pub base64: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CatalogCoursePackage {
    pub schema_version: u32,
    pub exported_at: i64,
    pub course: CatalogCourseMeta,
    pub course_md: String,
    pub structure: courses::StructureFile,
    pub submodules: Vec<CatalogSubmodulePackage>,
    pub files: Vec<CatalogFilePackage>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CatalogCourseSummary {
    pub id: String,
    #[serde(default)]
    pub origin_id: String,
    pub title: String,
    pub topic: String,
    pub language: String,
    #[serde(default = "default_course_format")]
    pub course_format: String,
    pub updated_at: i64,
    #[serde(default)]
    pub version: i64,
    pub modules: usize,
    pub lessons: usize,
    pub generated_lessons: usize,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub topics: Vec<String>,
    // Defaulted for robustness against minimal private-server implementations.
    #[serde(default)]
    pub view_url: String,
    #[serde(default)]
    pub download_url: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CatalogPublishResult {
    pub id: String,
    pub url: String,
    #[serde(default)]
    pub version: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CatalogUpdateStatus {
    pub course_id: String,
    pub catalog_id: Option<String>,
    pub local_version: i64,
    pub remote_version: Option<i64>,
    pub local_generated_lessons: usize,
    pub remote_generated_lessons: Option<usize>,
    pub available: bool,
}

// Recursively insert a (possibly nested) module tree into the DB, preserving
// each node's generation_state and parent_id chain.
fn insert_pkg_modules(
    conn: &rusqlite::Connection,
    course_id: &str,
    parent_id: Option<&str>,
    nodes: &[courses::ModuleNode],
) -> Result<(), String> {
    for (position, node) in nodes.iter().enumerate() {
        db::insert_module(
            conn,
            &node.id,
            course_id,
            parent_id,
            position as i64,
            &node.title,
            optional_text(&node.summary),
            &node.generation_state,
        )
        .map_err(|e| e.to_string())?;
        insert_pkg_modules(conn, course_id, Some(&node.id), &node.submodules)?;
    }
    Ok(())
}

// Depth-first collect content for a documentation tree: every node is an article
// addressed as ("_doc", node_id). Mirrors the 2-level packaging in build_package.
fn collect_doc_submodules(
    paths: &AppPaths,
    course_id: &str,
    course_root: &std::path::Path,
    nodes: &[courses::ModuleNode],
    files: &mut BTreeMap<String, CatalogFilePackage>,
    out: &mut Vec<CatalogSubmodulePackage>,
) -> Result<(), String> {
    for node in nodes {
        if let Ok(content) = courses::read_submodule_content(paths, course_id, "_doc", &node.id) {
            let mut widgets = content.widgets;
            rewrite_local_file_refs(&mut widgets, course_root, files)?;
            let assignments =
                courses::read_submodule_assignments(paths, course_id, "_doc", &node.id);
            out.push(CatalogSubmodulePackage {
                module_id: "_doc".to_string(),
                submodule_id: node.id.clone(),
                article: content.article,
                widgets,
                sources: content.sources,
                test: content.test,
                review_notes: content.review_notes,
                assignments,
                flashcards: content.flashcards,
            });
        }
        collect_doc_submodules(paths, course_id, course_root, &node.submodules, files, out)?;
    }
    Ok(())
}

pub fn build_package(
    conn: &rusqlite::Connection,
    paths: &AppPaths,
    course_id: &str,
) -> Result<CatalogCoursePackage, String> {
    let course = db::get_course(conn, course_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("course not found: {course_id}"))?;
    if course.status != "ready" {
        return Err("only courses with a generated structure can be published".to_string());
    }

    let structure = courses::load_structure(conn, course_id).map_err(|e| e.to_string())?;
    let course_md = courses::read_course_md(paths, course_id).unwrap_or_default();
    let course_dir = paths.course_dir(course_id);
    let course_root = course_dir
        .canonicalize()
        .map_err(|e| format!("course directory is not readable: {e}"))?;
    let mut files = BTreeMap::<String, CatalogFilePackage>::new();
    let mut submodules = Vec::new();

    if course.course_format == "documentation" {
        // Documentation is an arbitrarily-nested tree; every node is an article
        // whose content lives under ("_doc", node_id). Walk it depth-first so the
        // packaged order matches the structure (and thus the catalog lesson index).
        collect_doc_submodules(
            paths,
            course_id,
            &course_root,
            &structure.modules,
            &mut files,
            &mut submodules,
        )?;
    } else {
        for module in &structure.modules {
            for submodule in &module.submodules {
                let content = match courses::read_submodule_content(
                    paths,
                    course_id,
                    &module.id,
                    &submodule.id,
                ) {
                    Ok(content) => content,
                    Err(_) => continue,
                };
                let mut widgets = content.widgets;
                rewrite_local_file_refs(&mut widgets, &course_root, &mut files)?;
                let assignments = courses::read_submodule_assignments(
                    paths,
                    course_id,
                    &module.id,
                    &submodule.id,
                );
                submodules.push(CatalogSubmodulePackage {
                    module_id: module.id.clone(),
                    submodule_id: submodule.id.clone(),
                    article: content.article,
                    widgets,
                    sources: content.sources,
                    test: content.test,
                    review_notes: content.review_notes,
                    assignments,
                    flashcards: content.flashcards,
                });
            }
        }
    }

    if submodules.is_empty() {
        return Err("course has no generated lessons to publish".to_string());
    }

    let catalog_origin_id = course
        .catalog_origin_id
        .clone()
        .unwrap_or_else(|| course.id.clone());
    let catalog_version = now_secs();

    Ok(CatalogCoursePackage {
        schema_version: SCHEMA_VERSION,
        exported_at: catalog_version,
        course: CatalogCourseMeta {
            id: catalog_origin_id.clone(),
            topic: course.topic,
            title: course.title,
            tags: course.tags,
            language: course.language,
            course_format: course.course_format,
            agent: course.agent,
            created_at: course.created_at,
            updated_at: course.updated_at,
            catalog_origin_id: Some(catalog_origin_id),
            catalog_version,
        },
        course_md,
        structure,
        submodules,
        files: files.into_values().collect(),
    })
}

/// Install a package as a NATIVE local course (id = package id, origin = id) so
/// it stays first-class and publishable — as opposed to `install_package`, which
/// marks a course "imported" (new local id ≠ origin) and blocks re-publishing.
/// Used to ingest MCP-authored courses into the app store (LEG-46). Idempotent:
/// re-running upserts the same course id and rewrites its content.
pub fn install_local_package(
    conn: &rusqlite::Connection,
    paths: &AppPaths,
    package: CatalogCoursePackage,
) -> Result<String, String> {
    if package.schema_version != SCHEMA_VERSION {
        return Err(format!(
            "unsupported catalog package schema: {}",
            package.schema_version
        ));
    }
    let id = package.course.id.clone();
    if id.trim().is_empty() {
        return Err("package course id is empty".to_string());
    }
    let version = package_version(&package);
    let now = now_secs();
    // origin_id == course_id → the publish gate treats it as a local, publishable
    // course (not an imported catalog copy).
    write_package_to_course(conn, paths, &package, &id, &id, version, now, None)?;
    Ok(id)
}

pub fn install_package(
    conn: &rusqlite::Connection,
    paths: &AppPaths,
    package: CatalogCoursePackage,
    catalog_server_url: Option<&str>,
) -> Result<String, String> {
    if package.schema_version != SCHEMA_VERSION {
        return Err(format!(
            "unsupported catalog package schema: {}",
            package.schema_version
        ));
    }

    let origin_id = package_origin_id(&package);
    let package_version = package_version(&package);
    let title = package_title(&package);
    let now = now_secs();
    let existing = db::get_course(conn, &package.course.id)
        .map_err(|e| e.to_string())?
        .or_else(|| {
            db::get_course_by_catalog_origin(conn, &origin_id)
                .ok()
                .flatten()
        })
        .or_else(|| {
            db::find_catalog_duplicate_candidate(
                conn,
                &package.course.topic,
                Some(&title),
                &package.course.language,
            )
            .ok()
            .flatten()
        });
    // A fresh import gets a NEW local id (distinct from the catalog origin id) so
    // `course.id != catalog_origin_id` reliably marks it as imported — the publish
    // gate + "Imported" badge depend on that. Re-imports/updates still match the
    // existing local copy via catalog_origin_id (above), so dedup is unaffected.
    let course_id = existing
        .as_ref()
        .map(|course| course.id.clone())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    if let Some(existing_course) = existing.as_ref() {
        let local_generated = count_generated_lessons(conn, &existing_course.id).unwrap_or(0);
        if local_generated >= package.submodules.len()
            && existing_course.updated_at >= package.course.updated_at
        {
            db::set_course_catalog_sync(
                conn,
                &existing_course.id,
                &origin_id,
                package_version,
                now,
                catalog_server_url,
            )
            .map_err(|e| e.to_string())?;
            return Ok(existing_course.id.clone());
        }
    }

    write_package_to_course(
        conn,
        paths,
        &package,
        &course_id,
        &origin_id,
        package_version,
        now,
        catalog_server_url,
    )?;
    Ok(course_id)
}

pub fn update_installed_course(
    conn: &rusqlite::Connection,
    paths: &AppPaths,
    course_id: &str,
    package: CatalogCoursePackage,
) -> Result<String, String> {
    let course = db::get_course(conn, course_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("course not found: {course_id}"))?;
    let origin_id = course
        .catalog_origin_id
        .clone()
        .unwrap_or_else(|| package_origin_id(&package));
    if origin_id != package_origin_id(&package) {
        return Err("downloaded package does not match this course".to_string());
    }
    let package_version = package_version(&package);
    let now = now_secs();
    if course.catalog_version >= package_version {
        return Ok(course.id);
    }
    // Updates keep the course bound to the server it was installed from.
    write_package_to_course(
        conn,
        paths,
        &package,
        course_id,
        &origin_id,
        package_version,
        now,
        course.catalog_server_url.as_deref(),
    )?;
    Ok(course_id.to_string())
}

pub fn check_update(
    conn: &rusqlite::Connection,
    course: &db::Course,
    remote: &[CatalogCourseSummary],
) -> CatalogUpdateStatus {
    let catalog_id = course
        .catalog_origin_id
        .clone()
        .or_else(|| remote.iter().any(|item| item.id == course.id).then(|| course.id.clone()));
    let local_generated = count_generated_lessons(conn, &course.id).unwrap_or(0);
    let remote_item = catalog_id
        .as_ref()
        .and_then(|id| remote.iter().find(|item| &item.id == id));
    let remote_version = remote_item.map(|item| item.version);
    let remote_generated = remote_item.map(|item| item.generated_lessons);
    CatalogUpdateStatus {
        course_id: course.id.clone(),
        catalog_id,
        local_version: course.catalog_version,
        remote_version,
        local_generated_lessons: local_generated,
        remote_generated_lessons: remote_generated,
        available: remote_item
            .map(|item| {
                item.version > course.catalog_version
                    && item.generated_lessons > local_generated
            })
            .unwrap_or(false),
    }
}

#[allow(clippy::too_many_arguments)]
fn write_package_to_course(
    conn: &rusqlite::Connection,
    paths: &AppPaths,
    package: &CatalogCoursePackage,
    course_id: &str,
    origin_id: &str,
    package_version: i64,
    now: i64,
    catalog_server_url: Option<&str>,
) -> Result<(), String> {
    let title = package_title(package);
    db::upsert_imported_course(
        conn,
        course_id,
        &package.course.topic,
        Some(&title),
        &package.course.language,
        db::normalize_course_format(Some(&package.course.course_format)),
        if package.course.agent == "claude" {
            "claude"
        } else {
            "codex"
        },
        "ready",
        package.course.created_at,
        now,
        origin_id,
        package_version,
        now,
        catalog_server_url,
        &package.course.tags,
    )
    .map_err(|e| e.to_string())?;

    let course_dir = paths.course_dir(&course_id);
    if course_dir.exists() {
        fs::remove_dir_all(&course_dir).map_err(|e| e.to_string())?;
    }
    fs::create_dir_all(&course_dir).map_err(|e| e.to_string())?;
    fs::write(course_dir.join("course.md"), &package.course_md).map_err(|e| e.to_string())?;

    for file in &package.files {
        let dest = safe_join(&course_dir, &file.path)?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(file.base64.as_bytes())
            .map_err(|e| format!("bad file payload {}: {e}", file.path))?;
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(&dest, bytes).map_err(|e| e.to_string())?;
    }

    let structure = courses::StructureFile {
        course_id: course_id.to_string(),
        modules: package.structure.modules.clone(),
    };
    let structure_json = serde_json::to_string_pretty(&structure).map_err(|e| e.to_string())?;
    fs::write(course_dir.join("structure.json"), structure_json).map_err(|e| e.to_string())?;

    db::delete_modules_for_course(conn, course_id).map_err(|e| e.to_string())?;
    // Recursive so a documentation package's nested tree persists fully in the DB
    // (the package's structure.json already carries it); other formats are 2-level.
    insert_pkg_modules(conn, course_id, None, &structure.modules)?;

    for sub in &package.submodules {
        let module_id = sub.module_id.clone();
        let submodule_id = sub.submodule_id.clone();
        let mut widgets = sub.widgets.clone();
        restore_file_refs(&mut widgets, &course_dir)?;
        courses::write_submodule_article(
            paths,
            &course_id,
            &module_id,
            &submodule_id,
            &sub.article,
        )
        .map_err(|e| e.to_string())?;
        courses::write_submodule_widgets(paths, &course_id, &module_id, &submodule_id, &widgets)
            .map_err(|e| e.to_string())?;
        courses::write_submodule_sources(paths, &course_id, &module_id, &submodule_id, &sub.sources)
            .map_err(|e| e.to_string())?;
        courses::write_submodule_test(paths, &course_id, &module_id, &submodule_id, &sub.test)
            .map_err(|e| e.to_string())?;
        courses::write_submodule_review_notes(
            paths,
            &course_id,
            &module_id,
            &submodule_id,
            &sub.review_notes,
        )
        .map_err(|e| e.to_string())?;
        courses::write_submodule_assignments(
            paths,
            &course_id,
            &module_id,
            &submodule_id,
            &sub.assignments,
        )
        .map_err(|e| e.to_string())?;
        // Flashcards ship with the package since schema-1 packages gained the
        // field; sync the SRS deck so Mastery/review work on imported courses.
        // Older packages have Null here — skip, nothing to install.
        if sub.flashcards.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
            courses::write_submodule_flashcards(
                paths,
                &course_id,
                &module_id,
                &submodule_id,
                &sub.flashcards,
            )
            .map_err(|e| e.to_string())?;
            if let Err(e) = crate::srs::sync_cards_for_submodule(
                conn,
                &course_id,
                &module_id,
                &submodule_id,
                &sub.flashcards,
                now,
            ) {
                eprintln!("[catalog] flashcard sync failed for {submodule_id}: {e}");
            }
        }
    }

    Ok(())
}

pub fn list_remote(
    base_url: &str,
    query: Option<&str>,
) -> Result<Vec<CatalogCourseSummary>, String> {
    let mut url = format!("{}/api/catalog", normalize_base_url(base_url));
    if let Some(q) = query.map(str::trim).filter(|q| !q.is_empty()) {
        url.push_str("?q=");
        url.push_str(&urlencoding::encode(q));
    }
    // Fail fast: this runs on every ready-course open (update check). A slow or
    // unreachable catalog must not leave the request hanging.
    let response = ureq::get(&url)
        .timeout(Duration::from_secs(8))
        .call()
        .map_err(ureq_error)?;
    response.into_json().map_err(|e| e.to_string())
}

pub fn download_remote(base_url: &str, catalog_id: &str) -> Result<CatalogCoursePackage, String> {
    let url = format!(
        "{}/api/courses/{}/download",
        normalize_base_url(base_url),
        urlencoding::encode(catalog_id)
    );
    // Packages can be tens of MB, but a hung private server must still fail.
    let response = ureq::get(&url)
        .timeout(Duration::from_secs(60))
        .call()
        .map_err(ureq_error)?;
    response.into_json().map_err(|e| e.to_string())
}

pub fn publish_remote(
    base_url: &str,
    token: &str,
    package: &CatalogCoursePackage,
) -> Result<CatalogPublishResult, String> {
    if token.trim().is_empty() {
        return Err("catalog upload token is not configured".to_string());
    }
    let url = format!(
        "{}/api/courses/{}",
        normalize_base_url(base_url),
        urlencoding::encode(&package.course.id)
    );
    let body = serde_json::to_string(package).map_err(|e| e.to_string())?;
    let response = ureq::put(&url)
        .set("Content-Type", "application/json")
        .set("Authorization", &format!("Bearer {}", token.trim()))
        .send_string(&body)
        .map_err(ureq_error)?;
    response.into_json().map_err(|e| e.to_string())
}

fn package_origin_id(package: &CatalogCoursePackage) -> String {
    package
        .course
        .catalog_origin_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .unwrap_or(&package.course.id)
        .to_string()
}

fn package_version(package: &CatalogCoursePackage) -> i64 {
    package
        .course
        .catalog_version
        .max(package.exported_at)
        .max(package.course.updated_at)
}

fn package_title(package: &CatalogCoursePackage) -> String {
    package
        .course
        .title
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| package.course.topic.clone())
}

fn count_generated_lessons(conn: &rusqlite::Connection, course_id: &str) -> Result<usize, String> {
    let structure = courses::load_structure(conn, course_id).map_err(|e| e.to_string())?;
    Ok(structure
        .modules
        .iter()
        .flat_map(|module| module.submodules.iter())
        .filter(|submodule| submodule.generation_state == "ready")
        .count())
}

fn rewrite_local_file_refs(
    value: &mut Value,
    course_root: &Path,
    files: &mut BTreeMap<String, CatalogFilePackage>,
) -> Result<(), String> {
    match value {
        Value::String(s) => {
            let Some(path) = local_path_from_ref(s) else {
                return Ok(());
            };
            let Ok(canon) = path.canonicalize() else {
                return Ok(());
            };
            if !canon.starts_with(course_root) {
                return Ok(());
            }
            let rel = canon
                .strip_prefix(course_root)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            if !files.contains_key(&rel) {
                let bytes = fs::read(&canon).map_err(|e| e.to_string())?;
                files.insert(
                    rel.clone(),
                    CatalogFilePackage {
                        media_type: media_type_for_path(&canon),
                        path: rel.clone(),
                        base64: base64::engine::general_purpose::STANDARD.encode(bytes),
                    },
                );
            }
            *s = format!("{}{}", FILE_REF_PREFIX, urlencoding::encode(&rel));
        }
        Value::Array(arr) => {
            for item in arr {
                rewrite_local_file_refs(item, course_root, files)?;
            }
        }
        Value::Object(map) => {
            for item in map.values_mut() {
                rewrite_local_file_refs(item, course_root, files)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn restore_file_refs(value: &mut Value, course_dir: &Path) -> Result<(), String> {
    match value {
        Value::String(s) => {
            if let Some(rel) = decode_file_ref(s) {
                *s = safe_join(course_dir, &rel)?.to_string_lossy().to_string();
            }
        }
        Value::Array(arr) => {
            for item in arr {
                restore_file_refs(item, course_dir)?;
            }
        }
        Value::Object(map) => {
            for item in map.values_mut() {
                restore_file_refs(item, course_dir)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn local_path_from_ref(value: &str) -> Option<PathBuf> {
    if let Some(rest) = value.strip_prefix("file://") {
        let decoded = urlencoding::decode(rest).ok()?;
        return Some(PathBuf::from(decoded.into_owned()));
    }
    if value.starts_with('/') {
        return Some(PathBuf::from(value));
    }
    None
}

fn decode_file_ref(value: &str) -> Option<String> {
    let rest = value.strip_prefix(FILE_REF_PREFIX)?;
    urlencoding::decode(rest).ok().map(|s| s.into_owned())
}

fn optional_text(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

fn safe_join(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let mut out = PathBuf::from(root);
    for component in Path::new(rel).components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            _ => return Err(format!("unsafe package path: {rel}")),
        }
    }
    Ok(out)
}

/// Canonical form of a catalog base URL (trimmed, no trailing slash) — the
/// shared normalizer for storing, comparing and requesting.
pub fn normalize_base_url(url: &str) -> String {
    url.trim().trim_end_matches('/').to_string()
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn media_type_for_path(path: &Path) -> String {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "json" => "application/json",
        "txt" => "text/plain; charset=utf-8",
        "md" => "text/markdown; charset=utf-8",
        _ => "application/octet-stream",
    }
    .to_string()
}

fn ureq_error(error: ureq::Error) -> String {
    match error {
        ureq::Error::Status(code, response) => {
            let body = response.into_string().unwrap_or_default();
            if body.trim().is_empty() {
                format!("catalog API returned HTTP {code}")
            } else {
                format!("catalog API returned HTTP {code}: {body}")
            }
        }
        ureq::Error::Transport(err) => err.to_string(),
    }
}

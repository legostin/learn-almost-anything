use std::collections::{HashMap, HashSet};
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::time::Duration;

use image::{GenericImageView, ImageReader};
use regex::Regex;
use serde::{Deserialize, Serialize};
use url::Url;

#[derive(Debug, thiserror::Error)]
pub enum MediaError {
    #[error("brave api key not configured")]
    MissingKey,
    #[error("brave http: {0}")]
    BraveHttp(String),
    #[error("brave response: {0}")]
    BraveParse(String),
    #[error("download: {0}")]
    Download(String),
    #[error("decode: {0}")]
    Decode(String),
    #[error("image too small: {0}×{1}px, need ≥{2}px on the longer side")]
    TooSmall(u32, u32, u32),
    #[error("encode: {0}")]
    Encode(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BraveImageHit {
    pub title: String,
    pub source: String, // source page URL
    pub url: String,    // direct image URL
    pub thumbnail: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

/// Whether a search hit is big enough to ADD, by the dimensions the search
/// engine reported. Hits with unknown size pass (the decode-time floor in
/// `bytes_to_jpeg` is the backstop) — only hits we KNOW are too small are
/// dropped, so we never discard a candidate whose real size we haven't seen.
pub fn hit_meets_min_dim(hit: &BraveImageHit, min_dim: u32) -> bool {
    match (hit.width, hit.height) {
        (Some(w), Some(h)) => w.max(h) >= min_dim,
        _ => true,
    }
}

const IMAGE_ENDPOINT: &str = "https://api.search.brave.com/res/v1/images/search";
const MAX_DOWNLOAD_BYTES: usize = 20 * 1024 * 1024;
const MAX_HTML_BYTES: usize = 2 * 1024 * 1024;

/// Minimum acceptable size, in pixels on the longer side, for a real photo we
/// ADD to a course (search result, pasted URL, or upload). Smaller images look
/// like low-res thumbnails. Generated images are exempt (we control their size).
pub const MIN_ADDED_IMAGE_DIM: u32 = 800;

pub fn brave_image_search(
    api_key: &str,
    query: &str,
    count: u32,
) -> Result<Vec<BraveImageHit>, MediaError> {
    if api_key.is_empty() {
        return Err(MediaError::MissingKey);
    }
    let q = urlencoding::encode(query);
    let n = count.clamp(1, 50);
    let url = format!("{IMAGE_ENDPOINT}?q={q}&count={n}&safesearch=strict");
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(15))
        .build();
    let resp = agent
        .get(&url)
        .set("X-Subscription-Token", api_key)
        .set("Accept", "application/json")
        .set("Accept-Encoding", "identity")
        .call()
        .map_err(|e| MediaError::BraveHttp(e.to_string()))?;
    let status = resp.status();
    let body: serde_json::Value = resp
        .into_json()
        .map_err(|e| MediaError::BraveParse(format!("status {status}: {e}")))?;
    let arr = body
        .pointer("/results")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let out = arr
        .into_iter()
        .filter_map(|r| {
            let props = r
                .get("properties")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            // Brave returns the web page in `url`, the direct image in
            // `properties.url`, and the bare host in `source`.
            let page = r.get("url").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
            let image = props
                .get("url")
                .and_then(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| page.clone());
            if image.is_empty() {
                return None;
            }
            let thumb = r
                .pointer("/thumbnail/src")
                .and_then(|v| v.as_str())
                .unwrap_or(&image)
                .to_string();
            // Always carry a usable attribution source: prefer the real page
            // URL, then the site host (as https://), then the image URL itself —
            // so a search-added image is never left without a source link.
            let domain = r.get("source").and_then(|v| v.as_str()).unwrap_or("").trim();
            let source = if !page.is_empty() {
                page
            } else if !domain.is_empty() {
                let host = domain.trim_start_matches("https://").trim_start_matches("http://");
                format!("https://{host}")
            } else {
                image.clone()
            };
            Some(BraveImageHit {
                title: r
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                source,
                url: image,
                thumbnail: thumb,
                width: props.get("width").and_then(|v| v.as_u64()).map(|v| v as u32),
                height: props.get("height").and_then(|v| v.as_u64()).map(|v| v as u32),
            })
        })
        .collect();
    Ok(out)
}

const GOOGLE_IMAGE_ENDPOINT: &str = "https://www.googleapis.com/customsearch/v1";

/// Image search via the Google Programmable Search (Custom Search JSON API),
/// `searchType=image`. Returns the same `BraveImageHit` shape as Brave so the
/// rest of the pipeline is provider-agnostic. The API caps `num` at 10 per
/// request; we issue one request. `cx` is the Programmable Search Engine id.
pub fn google_image_search(
    api_key: &str,
    cx: &str,
    query: &str,
    count: u32,
) -> Result<Vec<BraveImageHit>, MediaError> {
    if api_key.is_empty() || cx.is_empty() {
        return Err(MediaError::MissingKey);
    }
    let q = urlencoding::encode(query);
    let n = count.clamp(1, 10);
    let url = format!(
        "{GOOGLE_IMAGE_ENDPOINT}?key={key}&cx={cx}&searchType=image&safe=active&num={n}&q={q}",
        key = urlencoding::encode(api_key),
        cx = urlencoding::encode(cx),
    );
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(15))
        .build();
    let resp = agent
        .get(&url)
        .set("Accept", "application/json")
        .set("Accept-Encoding", "identity")
        .call()
        .map_err(|e| MediaError::BraveHttp(e.to_string()))?;
    let status = resp.status();
    let body: serde_json::Value = resp
        .into_json()
        .map_err(|e| MediaError::BraveParse(format!("status {status}: {e}")))?;
    let arr = body
        .get("items")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let out = arr
        .into_iter()
        .filter_map(|r| {
            // `link` is the direct image; `image.contextLink` is the hosting page.
            let image = r.get("link").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
            if image.is_empty() {
                return None;
            }
            let meta = r.get("image").cloned().unwrap_or(serde_json::Value::Null);
            let page = meta
                .get("contextLink")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let thumb = meta
                .get("thumbnailLink")
                .and_then(|v| v.as_str())
                .unwrap_or(&image)
                .to_string();
            // Always carry a usable attribution source: the hosting page, else
            // the image URL itself.
            let source = if page.is_empty() { image.clone() } else { page };
            Some(BraveImageHit {
                title: r.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                source,
                url: image,
                thumbnail: thumb,
                width: meta.get("width").and_then(|v| v.as_u64()).map(|v| v as u32),
                height: meta.get("height").and_then(|v| v.as_u64()).map(|v| v as u32),
            })
        })
        .collect();
    Ok(out)
}

#[derive(Debug, Clone)]
struct ExtractedImage {
    url: String,
    score: i32,
    width: Option<u32>,
    height: Option<u32>,
}

/// Expand a search result into concrete image candidates. Brave sometimes
/// returns blocked, downscaled, or hotlink-hostile direct URLs while the source
/// page contains better `og:image`, `srcset`, JSON-LD, or Wikimedia/IIIF image
/// URLs. This only reads public HTML and never bypasses auth, paywalls, or DRM.
pub fn expanded_image_candidates(hit: &BraveImageHit, limit: usize) -> Vec<BraveImageHit> {
    let mut out = Vec::new();
    let mut seen = HashSet::<String>::new();

    if is_usable_remote_image_url(&hit.url) {
        seen.insert(hit.url.clone());
        out.push(hit.clone());
    }

    if !hit.source.trim().is_empty() && out.len() < limit {
        match extract_images_from_page(&hit.source) {
            Ok(mut extracted) => {
                extracted.sort_by(|a, b| {
                    b.score
                        .cmp(&a.score)
                        .then_with(|| image_area(b).cmp(&image_area(a)))
                });
                for img in extracted {
                    if out.len() >= limit {
                        break;
                    }
                    if seen.insert(img.url.clone()) {
                        out.push(BraveImageHit {
                            title: hit.title.clone(),
                            source: hit.source.clone(),
                            url: img.url,
                            thumbnail: hit.thumbnail.clone(),
                            width: img.width.or(hit.width),
                            height: img.height.or(hit.height),
                        });
                    }
                }
            }
            Err(e) => eprintln!("[media] extract images from '{}': {e}", hit.source),
        }
    }

    out.truncate(limit);
    out
}

fn image_area(img: &ExtractedImage) -> u64 {
    img.width.unwrap_or(0) as u64 * img.height.unwrap_or(0) as u64
}

fn extract_images_from_page(page_url: &str) -> Result<Vec<ExtractedImage>, MediaError> {
    let base = Url::parse(page_url).map_err(|e| MediaError::Download(e.to_string()))?;
    let html = fetch_public_html(page_url)?;
    let mut out = Vec::<ExtractedImage>::new();

    for tag in html_tags(&html, "meta") {
        let attrs = parse_attrs(&tag);
        let key = attrs
            .get("property")
            .or_else(|| attrs.get("name"))
            .or_else(|| attrs.get("itemprop"))
            .map(|s| s.to_ascii_lowercase())
            .unwrap_or_default();
        if matches!(
            key.as_str(),
            "og:image"
                | "og:image:url"
                | "og:image:secure_url"
                | "twitter:image"
                | "twitter:image:src"
                | "thumbnailurl"
                | "image"
        ) {
            if let Some(url) = attrs.get("content").and_then(|v| absolutize(&base, v)) {
                push_candidate(&mut out, url, 100, None, None);
            }
        }
    }

    for tag in html_tags(&html, "link") {
        let attrs = parse_attrs(&tag);
        let rel = attrs.get("rel").map(|s| s.to_ascii_lowercase()).unwrap_or_default();
        let as_attr = attrs.get("as").map(|s| s.to_ascii_lowercase()).unwrap_or_default();
        if rel.contains("image_src") || (rel.contains("preload") && as_attr == "image") {
            if let Some(url) = attrs.get("href").and_then(|v| absolutize(&base, v)) {
                push_candidate(&mut out, url, 90, None, None);
            }
        }
    }

    for tag in html_tags(&html, "source").into_iter().chain(html_tags(&html, "img")) {
        let attrs = parse_attrs(&tag);
        let width = attrs.get("width").and_then(|v| parse_dimension(v));
        let height = attrs.get("height").and_then(|v| parse_dimension(v));
        if looks_like_tracking_pixel(width, height) {
            continue;
        }
        if let Some(srcset) = attrs
            .get("srcset")
            .or_else(|| attrs.get("data-srcset"))
            .or_else(|| attrs.get("data-lazy-srcset"))
        {
            if let Some(raw) = best_srcset_url(srcset) {
                if let Some(url) = absolutize(&base, &raw) {
                    push_candidate(&mut out, url, 70, width, height);
                }
            }
        }
        for key in ["src", "data-src", "data-original", "data-lazy-src", "data-full-url"] {
            if let Some(url) = attrs.get(key).and_then(|v| absolutize(&base, v)) {
                push_candidate(&mut out, url, 55, width, height);
            }
        }
    }

    for json_text in json_ld_blocks(&html) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&json_text) {
            collect_json_images(&value, &base, &mut out);
        }
    }

    out.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| image_area(b).cmp(&image_area(a)))
    });
    let mut seen = HashSet::new();
    out.retain(|img| seen.insert(img.url.clone()));
    Ok(out)
}

fn fetch_public_html(page_url: &str) -> Result<String, MediaError> {
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(12))
        .redirects(5)
        .build();
    let resp = agent
        .get(page_url)
        .set("Accept", "text/html,application/xhtml+xml")
        .set("Accept-Encoding", "identity")
        .set("User-Agent", "Mozilla/5.0 (Learn-Almost-Anything)")
        .call()
        .map_err(|e| MediaError::Download(e.to_string()))?;
    let content_type = resp
        .header("content-type")
        .unwrap_or("")
        .to_ascii_lowercase();
    if !content_type.is_empty()
        && !content_type.contains("text/html")
        && !content_type.contains("application/xhtml")
    {
        return Err(MediaError::Download(format!("not html: {content_type}")));
    }
    let mut bytes = Vec::new();
    resp.into_reader()
        .take((MAX_HTML_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| MediaError::Download(e.to_string()))?;
    if bytes.len() > MAX_HTML_BYTES {
        return Err(MediaError::Download(format!(
            "html larger than {}MB cap",
            MAX_HTML_BYTES / 1024 / 1024
        )));
    }
    String::from_utf8(bytes).map_err(|e| MediaError::Decode(e.to_string()))
}

fn html_tags(html: &str, tag: &str) -> Vec<String> {
    let pattern = format!(r#"(?is)<{}\b[^>]*>"#, regex::escape(tag));
    Regex::new(&pattern)
        .ok()
        .map(|re| re.find_iter(html).map(|m| m.as_str().to_string()).collect())
        .unwrap_or_default()
}

fn parse_attrs(tag: &str) -> HashMap<String, String> {
    let Ok(re) = Regex::new(
        r#"(?is)([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))"#,
    ) else {
        return HashMap::new();
    };
    re.captures_iter(tag)
        .filter_map(|cap| {
            let key = cap.get(1)?.as_str().to_ascii_lowercase();
            let raw = cap
                .get(2)
                .or_else(|| cap.get(3))
                .or_else(|| cap.get(4))?
                .as_str();
            Some((key, html_unescape_attr(raw.trim())))
        })
        .collect()
}

fn html_unescape_attr(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

fn absolutize(base: &Url, raw: &str) -> Option<String> {
    let value = html_unescape_attr(raw.trim());
    if value.is_empty()
        || value.starts_with("data:")
        || value.starts_with("blob:")
        || value.starts_with("javascript:")
    {
        return None;
    }
    let url = base.join(&value).ok()?;
    let s = url.to_string();
    if is_usable_remote_image_url(&s) {
        Some(s)
    } else {
        None
    }
}

fn is_usable_remote_image_url(url: &str) -> bool {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return false;
    }
    let lower = url.to_ascii_lowercase();
    !lower.starts_with("data:")
        && !lower.contains(".svg")
        && !lower.contains("sprite")
        && !lower.contains("logo")
        && !lower.contains("favicon")
}

fn parse_dimension(value: &str) -> Option<u32> {
    value
        .trim()
        .trim_end_matches("px")
        .parse::<f32>()
        .ok()
        .map(|v| v.round() as u32)
}

fn looks_like_tracking_pixel(width: Option<u32>, height: Option<u32>) -> bool {
    matches!((width, height), (Some(w), Some(h)) if w < 80 || h < 80)
}

fn best_srcset_url(srcset: &str) -> Option<String> {
    srcset
        .split(',')
        .filter_map(|entry| {
            let mut parts = entry.split_whitespace();
            let url = parts.next()?.trim();
            let descriptor = parts.next().unwrap_or("");
            let score = descriptor
                .trim_end_matches('w')
                .trim_end_matches('x')
                .parse::<f32>()
                .unwrap_or(1.0);
            Some((url.to_string(), (score * 1000.0) as i32))
        })
        .max_by_key(|(_, score)| *score)
        .map(|(url, _)| url)
}

fn json_ld_blocks(html: &str) -> Vec<String> {
    let Ok(re) = Regex::new(
        r#"(?is)<script\b[^>]*type\s*=\s*["'][^"']*ld\+json[^"']*["'][^>]*>(.*?)</script>"#,
    ) else {
        return Vec::new();
    };
    re.captures_iter(html)
        .filter_map(|cap| cap.get(1).map(|m| html_unescape_attr(m.as_str().trim())))
        .collect()
}

fn collect_json_images(value: &serde_json::Value, base: &Url, out: &mut Vec<ExtractedImage>) {
    match value {
        serde_json::Value::Array(arr) => {
            for item in arr {
                collect_json_images(item, base, out);
            }
        }
        serde_json::Value::Object(map) => {
            let type_text = map
                .get("@type")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            for key in ["image", "thumbnailUrl", "contentUrl"] {
                if let Some(v) = map.get(key) {
                    collect_json_image_value(v, base, out, 95);
                }
            }
            if type_text.contains("imageobject") {
                if let Some(v) = map.get("url") {
                    collect_json_image_value(v, base, out, 95);
                }
            }
            for child in map.values() {
                collect_json_images(child, base, out);
            }
        }
        _ => {}
    }
}

fn collect_json_image_value(
    value: &serde_json::Value,
    base: &Url,
    out: &mut Vec<ExtractedImage>,
    score: i32,
) {
    match value {
        serde_json::Value::String(s) => {
            if let Some(url) = absolutize(base, s) {
                push_candidate(out, url, score, None, None);
            }
        }
        serde_json::Value::Array(arr) => {
            for item in arr {
                collect_json_image_value(item, base, out, score);
            }
        }
        serde_json::Value::Object(map) => {
            for key in ["url", "contentUrl", "thumbnailUrl"] {
                if let Some(v) = map.get(key) {
                    collect_json_image_value(v, base, out, score);
                }
            }
        }
        _ => {}
    }
}

fn push_candidate(
    out: &mut Vec<ExtractedImage>,
    url: String,
    score: i32,
    width: Option<u32>,
    height: Option<u32>,
) {
    if !is_usable_remote_image_url(&url) || looks_like_tracking_pixel(width, height) {
        return;
    }
    out.push(ExtractedImage {
        url,
        score,
        width,
        height,
    });
}

/// Download, decode any common format, resize so the longer side is at most
/// `max_dim`, re-encode as JPEG quality 85. Returns the JPEG bytes. Rejects
/// images whose longer side is below `min_dim` (pass 0 to disable the floor).
pub fn download_resize_jpeg(url: &str, max_dim: u32, min_dim: u32) -> Result<Vec<u8>, MediaError> {
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(30))
        .redirects(5)
        .build();
    let resp = agent
        .get(url)
        .set("Accept", "image/*")
        .set("User-Agent", "Mozilla/5.0 (Learn-Almost-Anything)")
        .call()
        .map_err(|e| MediaError::Download(e.to_string()))?;
    let mut bytes: Vec<u8> = Vec::new();
    resp.into_reader()
        .take((MAX_DOWNLOAD_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| MediaError::Download(e.to_string()))?;
    if bytes.len() > MAX_DOWNLOAD_BYTES {
        return Err(MediaError::Download(format!(
            "image larger than {}MB cap",
            MAX_DOWNLOAD_BYTES / 1024 / 1024
        )));
    }
    bytes_to_jpeg(&bytes, max_dim, min_dim)
}

/// Decode any common image format, resize so the longer side is at most
/// `max_dim`, re-encode as JPEG quality 85. Rejects images whose longer side is
/// below `min_dim` (pass 0 to disable the floor — e.g. for generated images).
pub fn bytes_to_jpeg(bytes: &[u8], max_dim: u32, min_dim: u32) -> Result<Vec<u8>, MediaError> {
    let img = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| MediaError::Decode(e.to_string()))?
        .decode()
        .map_err(|e| MediaError::Decode(e.to_string()))?;
    let (w, h) = img.dimensions();
    let longer = w.max(h);
    if min_dim > 0 && longer < min_dim {
        return Err(MediaError::TooSmall(w, h, min_dim));
    }
    let resized = if longer > max_dim {
        let ratio = max_dim as f32 / longer as f32;
        let new_w = ((w as f32 * ratio).round() as u32).max(1);
        let new_h = ((h as f32 * ratio).round() as u32).max(1);
        img.resize(new_w, new_h, image::imageops::FilterType::Lanczos3)
    } else {
        img
    };
    let rgb = resized.to_rgb8();
    let (rw, rh) = (rgb.width(), rgb.height());
    let mut out: Vec<u8> = Vec::with_capacity(rgb.len() / 4);
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 85)
        .encode(&rgb.into_raw(), rw, rh, image::ExtendedColorType::Rgb8)
        .map_err(|e| MediaError::Encode(e.to_string()))?;
    Ok(out)
}

/// Always use v1beta — it exposes both production and preview Gemini models,
/// so a single endpoint works for the full ListModels catalog the user picks
/// in Settings (v1 doesn't always include preview/v3 image+TTS variants).
fn gemini_endpoint(model: &str) -> String {
    format!("https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent")
}

/// Generate an image with a Gemini image-generation model (e.g. Nano Banana).
/// Returns raw image bytes (PNG) from the first inline-data part.
pub fn gemini_generate_image(
    api_key: &str,
    prompt: &str,
    model: &str,
) -> Result<Vec<u8>, MediaError> {
    if api_key.is_empty() {
        return Err(MediaError::MissingKey);
    }
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(120))
        .build();
    let resp = agent
        .post(&gemini_endpoint(model))
        .set("x-goog-api-key", api_key)
        .set("Content-Type", "application/json")
        .send_json(serde_json::json!({
            "contents": [{ "parts": [{ "text": prompt }] }]
        }))
        .map_err(|e| MediaError::BraveHttp(e.to_string()))?;
    let body: serde_json::Value = resp
        .into_json()
        .map_err(|e| MediaError::BraveParse(e.to_string()))?;
    let parts = body
        .pointer("/candidates/0/content/parts")
        .and_then(|v| v.as_array())
        .ok_or_else(|| MediaError::BraveParse("no candidate parts".into()))?;
    let b64 = parts
        .iter()
        .find_map(|p| {
            p.get("inlineData")
                .or_else(|| p.get("inline_data"))
                .and_then(|d| d.get("data"))
                .and_then(|d| d.as_str())
        })
        .ok_or_else(|| MediaError::BraveParse("no inline image data".into()))?;
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| MediaError::Decode(e.to_string()))
}

fn parse_pcm_rate(mime: &str) -> Option<u32> {
    mime.split(';')
        .find_map(|p| p.trim().strip_prefix("rate=").and_then(|r| r.parse::<u32>().ok()))
}

/// Wrap raw little-endian PCM in a minimal RIFF/WAVE header so a browser
/// <audio> element can play it directly.
fn wav_wrap(pcm: &[u8], sample_rate: u32, channels: u16, bits: u16) -> Vec<u8> {
    let byte_rate = sample_rate * channels as u32 * (bits as u32 / 8);
    let block_align = channels * (bits / 8);
    let data_len = pcm.len() as u32;
    let mut out = Vec::with_capacity(44 + pcm.len());
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&channels.to_le_bytes());
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&byte_rate.to_le_bytes());
    out.extend_from_slice(&block_align.to_le_bytes());
    out.extend_from_slice(&bits.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    out.extend_from_slice(pcm);
    out
}

/// Synthesize speech with a Gemini TTS model. Returns WAV bytes (PCM wrapped
/// in a RIFF header). PAID: bills the caller's Gemini API key.
pub fn gemini_tts(
    api_key: &str,
    text: &str,
    voice: &str,
    model: &str,
) -> Result<Vec<u8>, MediaError> {
    if api_key.is_empty() {
        return Err(MediaError::MissingKey);
    }
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(120))
        .build();
    let resp = agent
        .post(&gemini_endpoint(model))
        .set("x-goog-api-key", api_key)
        .set("Content-Type", "application/json")
        .send_json(serde_json::json!({
            "contents": [{ "parts": [{ "text": text }] }],
            "generationConfig": {
                "responseModalities": ["AUDIO"],
                "speechConfig": {
                    "voiceConfig": { "prebuiltVoiceConfig": { "voiceName": voice } }
                }
            }
        }))
        .map_err(|e| MediaError::BraveHttp(e.to_string()))?;
    let body: serde_json::Value = resp
        .into_json()
        .map_err(|e| MediaError::BraveParse(e.to_string()))?;
    let inline = body
        .pointer("/candidates/0/content/parts/0/inlineData")
        .or_else(|| body.pointer("/candidates/0/content/parts/0/inline_data"))
        .ok_or_else(|| MediaError::BraveParse("no audio inlineData".into()))?;
    let b64 = inline
        .get("data")
        .and_then(|d| d.as_str())
        .ok_or_else(|| MediaError::BraveParse("no audio data".into()))?;
    let mime = inline
        .get("mimeType")
        .or_else(|| inline.get("mime_type"))
        .and_then(|m| m.as_str())
        .unwrap_or("audio/L16;codec=pcm;rate=24000");
    use base64::Engine;
    let pcm = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| MediaError::Decode(e.to_string()))?;
    let rate = parse_pcm_rate(mime).unwrap_or(24000);
    Ok(wav_wrap(&pcm, rate, 1, 16))
}

/// Fetch the catalog of models available to the caller's Gemini key and
/// split them into image- and TTS-capable groups.
pub fn list_gemini_models(api_key: &str) -> Result<serde_json::Value, MediaError> {
    if api_key.is_empty() {
        return Err(MediaError::MissingKey);
    }
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(20))
        .build();
    let resp = agent
        .get("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200")
        .set("x-goog-api-key", api_key)
        .call()
        .map_err(|e| MediaError::BraveHttp(e.to_string()))?;
    let body: serde_json::Value = resp
        .into_json()
        .map_err(|e| MediaError::BraveParse(e.to_string()))?;
    let mut image = Vec::new();
    let mut tts = Vec::new();
    if let Some(models) = body.get("models").and_then(|m| m.as_array()) {
        for m in models {
            let name = m.get("name").and_then(|n| n.as_str()).unwrap_or("");
            let id = name.strip_prefix("models/").unwrap_or(name).to_string();
            if id.is_empty() {
                continue;
            }
            let supports_generate = m
                .get("supportedGenerationMethods")
                .and_then(|s| s.as_array())
                .map(|a| a.iter().any(|x| x.as_str() == Some("generateContent")))
                .unwrap_or(false);
            if !supports_generate {
                continue;
            }
            let label = m
                .get("displayName")
                .and_then(|n| n.as_str())
                .map(str::to_string)
                .unwrap_or_else(|| id.clone());
            let info = serde_json::json!({ "id": id, "label": label });
            let lower = name.to_lowercase();
            if lower.contains("tts") {
                tts.push(info);
            } else if lower.contains("image") && !lower.contains("imagen") {
                image.push(info);
            }
        }
    }
    Ok(serde_json::json!({ "image": image, "tts": tts }))
}

pub fn save_bytes(bytes: &[u8], path: &Path) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, bytes)
}

pub fn submodule_images_dir(course_dir: &Path, mod_id: &str, sub_id: &str) -> PathBuf {
    course_dir
        .join("modules")
        .join(mod_id)
        .join(sub_id)
        .join("images")
}

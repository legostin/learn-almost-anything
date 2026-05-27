use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::time::Duration;

use image::{GenericImageView, ImageReader};
use serde::{Deserialize, Serialize};

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

const IMAGE_ENDPOINT: &str = "https://api.search.brave.com/res/v1/images/search";
const MAX_DOWNLOAD_BYTES: usize = 20 * 1024 * 1024;

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
            let url = props
                .get("url")
                .and_then(|v| v.as_str())
                .or_else(|| r.get("url").and_then(|v| v.as_str()))?
                .to_string();
            let thumb = r
                .pointer("/thumbnail/src")
                .and_then(|v| v.as_str())
                .unwrap_or(&url)
                .to_string();
            Some(BraveImageHit {
                title: r
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                source: r
                    .get("source")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                url,
                thumbnail: thumb,
                width: props.get("width").and_then(|v| v.as_u64()).map(|v| v as u32),
                height: props.get("height").and_then(|v| v.as_u64()).map(|v| v as u32),
            })
        })
        .collect();
    Ok(out)
}

/// Download, decode any common format, resize so the longer side is at most
/// `max_dim`, re-encode as JPEG quality 85. Returns the JPEG bytes.
pub fn download_resize_jpeg(url: &str, max_dim: u32) -> Result<Vec<u8>, MediaError> {
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(30))
        .redirects(5)
        .build();
    let resp = agent
        .get(url)
        .set("Accept", "image/*")
        .set("User-Agent", "Mozilla/5.0 (Learn Anything)")
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

    let img = ImageReader::new(Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(|e| MediaError::Decode(e.to_string()))?
        .decode()
        .map_err(|e| MediaError::Decode(e.to_string()))?;
    let (w, h) = img.dimensions();
    let longer = w.max(h);
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

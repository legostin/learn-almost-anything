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
    bytes_to_jpeg(&bytes, max_dim)
}

/// Decode any common image format, resize so the longer side is at most
/// `max_dim`, re-encode as JPEG quality 85.
pub fn bytes_to_jpeg(bytes: &[u8], max_dim: u32) -> Result<Vec<u8>, MediaError> {
    let img = ImageReader::new(Cursor::new(bytes))
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

// Process-wide event hub. Tauri's `app.emit` reaches only the local webview;
// remote (shared) clients poll this hub over HTTP instead. Every UI event is
// mirrored here so a tablet on the ngrok URL stays in sync with the desktop.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Serialize)]
pub struct EventRecord {
    pub seq: u64,
    pub event: String,
    pub payload: Value,
}

pub struct EventHub {
    seq: AtomicU64,
    buf: Mutex<VecDeque<EventRecord>>,
    cap: usize,
}

impl EventHub {
    fn new() -> Self {
        Self {
            seq: AtomicU64::new(0),
            buf: Mutex::new(VecDeque::new()),
            cap: 1000,
        }
    }

    pub fn publish(&self, event: &str, payload: Value) {
        let seq = self.seq.fetch_add(1, Ordering::Relaxed) + 1;
        let mut buf = self.buf.lock().unwrap();
        buf.push_back(EventRecord {
            seq,
            event: event.to_string(),
            payload,
        });
        while buf.len() > self.cap {
            buf.pop_front();
        }
    }

    /// Events newer than `since`, plus the current cursor to poll from next.
    pub fn since(&self, since: u64) -> (Vec<EventRecord>, u64) {
        let buf = self.buf.lock().unwrap();
        let cursor = self.seq.load(Ordering::Relaxed);
        let events = buf.iter().filter(|r| r.seq > since).cloned().collect();
        (events, cursor)
    }

    pub fn cursor(&self) -> u64 {
        self.seq.load(Ordering::Relaxed)
    }
}

static HUB: OnceLock<EventHub> = OnceLock::new();

pub fn event_hub() -> &'static EventHub {
    HUB.get_or_init(EventHub::new)
}

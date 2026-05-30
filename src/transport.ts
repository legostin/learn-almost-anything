// Transport abstraction: the same calls work whether the app runs inside the
// Tauri webview (native IPC) or in a remote browser reached over the ngrok
// tunnel (HTTP + long-poll). App code imports invoke/listen/convertFileSrc from
// here instead of @tauri-apps/api, so neither side needs to know the difference.

import {
  invoke as tauriInvoke,
  convertFileSrc as tauriConvert,
} from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";

export const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

type EventCallback<T> = (event: { payload: T }) => void;
type UnlistenFn = () => void;

// `ngrok-skip-browser-warning` suppresses ngrok's free-tier interstitial on
// XHR/fetch (the one-time HTML warning page is unavoidable on first navigation).
const HTTP_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "ngrok-skip-browser-warning": "true",
};

export async function invoke<T>(
  cmd: string,
  args?: Record<string, unknown>
): Promise<T> {
  if (isTauri) return tauriInvoke<T>(cmd, args);
  const res = await fetch(`/api/cmd/${cmd}`, {
    method: "POST",
    headers: HTTP_HEADERS,
    body: JSON.stringify(args ?? {}),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(body || `Command ${cmd} failed with HTTP ${res.status}`);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export function convertFileSrc(path: string, protocol?: string): string {
  if (isTauri) return tauriConvert(path, protocol);
  return `/media?path=${encodeURIComponent(path)}`;
}

// --- Browser event delivery: one shared long-poll loop fans out to listeners ---

const listeners = new Map<string, Set<EventCallback<unknown>>>();
let cursor = 0;
let pollerStarted = false;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ensurePoller() {
  if (pollerStarted) return;
  pollerStarted = true;
  // Start from "now" so a freshly loaded tablet doesn't replay old events.
  try {
    const res = await fetch("/api/events", { headers: HTTP_HEADERS });
    const data = await res.json();
    cursor = data.cursor ?? 0;
  } catch {
    /* poll loop will retry */
  }
  pollLoop();
}

async function pollLoop() {
  for (;;) {
    try {
      const res = await fetch(`/api/events?since=${cursor}`, {
        headers: HTTP_HEADERS,
      });
      if (res.ok) {
        const data = await res.json();
        cursor = data.cursor ?? cursor;
        for (const rec of data.events ?? []) {
          const set = listeners.get(rec.event);
          if (set) for (const cb of set) cb({ payload: rec.payload });
        }
      }
    } catch {
      /* network blip — keep polling */
    }
    await sleep(1000);
  }
}

export async function listen<T>(
  event: string,
  handler: EventCallback<T>
): Promise<UnlistenFn> {
  if (isTauri) return tauriListen<T>(event, handler);
  let set = listeners.get(event);
  if (!set) {
    set = new Set();
    listeners.set(event, set);
  }
  const cb = handler as EventCallback<unknown>;
  set.add(cb);
  ensurePoller();
  return () => {
    set?.delete(cb);
  };
}

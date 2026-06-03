// Agent transcript logging (the in-app debug panel reads what this writes).
//
// Gated at runtime by a flag FILE (<devlog dir>/enabled) that the Rust side
// creates/removes from the Settings "debug logging" toggle — so it flips on and
// off without restarting the sidecar. When off, every export here is a cheap
// no-op, so normal use carries near-zero overhead and writes nothing.
// LEARN_ANYTHING_DEVLOG=1 still force-enables it (handy for headless dev).
//
// What it captures, per LLM call:
//   - which method/stage and which course/section it belongs to
//   - the FULL prompt we send
//   - the reasoning chain (thinking/reasoning text) as it streams
//   - tool calls (web/image searches, fetches, commands)
//   - the FULL final response
//
// Output: a single growing file at ~/.learn-anything/devlogs/agents.log
// (override the directory with LEARN_ANYTHING_DEVLOG_DIR). Every write is one
// atomic append tagged with #<reqId>, so concurrent calls never tear mid-block
// and `grep "#42"` reconstructs one call's whole chain. Short breadcrumbs also
// go to stderr, which the dev build forwards into the tauri dev log.

import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

// LEARN_ANYTHING_DEVLOG=1 force-enables (headless dev). Otherwise the Rust side
// toggles a flag file we poll, so Settings can flip logging without a restart.
const ENV_FORCE = process.env.LEARN_ANYTHING_DEVLOG === "1";

const als = new AsyncLocalStorage();
let counter = 0;
let logFile = null;
let flagCache = { at: 0, on: false };

const NOOP_RECORDER = {
  reasoning() {},
  tool() {},
  end() {},
  error() {},
};

function devlogDir() {
  return process.env.LEARN_ANYTHING_DEVLOG_DIR || join(homedir(), ".learn-anything", "devlogs");
}

export function isEnabled() {
  if (ENV_FORCE) return true;
  const now = Date.now();
  if (now - flagCache.at < 1500) return flagCache.on;
  let on = false;
  try {
    on = existsSync(join(devlogDir(), "enabled"));
  } catch {
    on = false;
  }
  flagCache = { at: now, on };
  return on;
}

function ensureFile() {
  if (logFile) return logFile;
  const dir = devlogDir();
  try {
    mkdirSync(dir, { recursive: true });
    logFile = join(dir, "agents.log");
  } catch {
    logFile = join(tmpdir(), "learn-anything-agents.log");
  }
  return logFile;
}

function write(text) {
  if (!isEnabled()) return;
  try {
    appendFileSync(ensureFile(), text);
  } catch {
    // Logging must never break an agent run.
  }
}

function crumb(text) {
  if (!isEnabled()) return;
  process.stderr.write(`[devlog] ${text}\n`);
}

function now() {
  return new Date().toISOString();
}

function current() {
  return als.getStore() || {};
}

function ctxLabel(ctx) {
  const parts = [];
  if (ctx.course) parts.push(`course=${JSON.stringify(ctx.course)}`);
  if (ctx.section) parts.push(`› ${JSON.stringify(ctx.section)}`);
  return parts.join(" ");
}

function bar() {
  return "─".repeat(72);
}

// Wrap a request handler so every nested agent call shares the same course /
// method / reqId context. Logs the request boundary (start + end + duration).
export async function runRequest(meta, fn) {
  if (!isEnabled()) return fn();
  const ctx = { ...meta, reqId: ++counter, started: Date.now() };
  return als.run(ctx, async () => {
    const head = `${ctx.method} #${ctx.reqId} ${ctxLabel(ctx)} backend=${ctx.backend || "?"}`;
    write(`\n${bar()}\n[${now()}] ▶ REQUEST ${head}\n`);
    crumb(`▶ ${ctx.method} #${ctx.reqId} ${ctxLabel(ctx)}`);
    try {
      const result = await fn();
      const secs = ((Date.now() - ctx.started) / 1000).toFixed(1);
      write(`[${now()}] ✓ REQUEST ${ctx.method} #${ctx.reqId} (${secs}s)\n`);
      crumb(`✓ ${ctx.method} #${ctx.reqId} (${secs}s)`);
      return result;
    } catch (e) {
      const secs = ((Date.now() - ctx.started) / 1000).toFixed(1);
      write(`[${now()}] ✗ REQUEST ${ctx.method} #${ctx.reqId} (${secs}s) — ${String(e?.message ?? e)}\n`);
      crumb(`✗ ${ctx.method} #${ctx.reqId} — ${String(e?.message ?? e)}`);
      throw e;
    }
  });
}

// Begin recording one LLM call. `info`: { kind?, prompt, model?, backend? }.
// Returns a recorder; call .reasoning()/.tool() as the stream arrives, then
// .end(response) or .error(err). No-op when logging is disabled.
export function startCall(info = {}) {
  if (!isEnabled()) return NOOP_RECORDER;
  const ctx = current();
  const reqId = ctx.reqId ?? 0;
  const kind = info.kind || ctx.method || "call";
  const model = info.model || ctx.model || "";
  const backend = info.backend || ctx.backend || "";
  const prompt = typeof info.prompt === "string" ? info.prompt : "";
  const started = Date.now();

  const header =
    `[#${reqId}] ${kind} ${ctxLabel(ctx)} backend=${backend}` + (model ? ` model=${model}` : "");
  write(`\n┌─[${now()}] ▶ ${header}\n│ PROMPT (${prompt.length} chars):\n${prompt}\n└${bar()}\n`);
  crumb(`  ↳ LLM ${kind} #${reqId} model=${model || "default"} prompt=${prompt.length}ch`);

  return {
    reasoning(text) {
      const t = typeof text === "string" ? text.trim() : "";
      if (t) write(`·[${now()}] [#${reqId}] 🧠 think:\n${t}\n`);
    },
    tool(label, detail) {
      const d = detail ? `: ${detail}` : "";
      write(`·[${now()}] [#${reqId}] 🔧 ${label}${d}\n`);
    },
    end(response) {
      const r = typeof response === "string" ? response : "";
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      write(
        `\n┌─[${now()}] ✓ ${kind} #${reqId} (${secs}s)\n│ RESPONSE (${r.length} chars):\n${r}\n└${bar()}\n`
      );
      crumb(`  ↳ done ${kind} #${reqId} (${secs}s) response=${r.length}ch`);
    },
    error(err) {
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      write(`\n┌─[${now()}] ✗ ${kind} #${reqId} (${secs}s)\n│ ERROR: ${String(err?.message ?? err)}\n└${bar()}\n`);
      crumb(`  ↳ error ${kind} #${reqId} — ${String(err?.message ?? err)}`);
    },
  };
}

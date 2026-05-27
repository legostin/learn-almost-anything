// Validation for type="interactive" widgets — used by both backends.
// 1) Static lint (regex + JS parse) — fast.
// 2) Runtime check via jsdom — catches runtime errors that lint misses.

import { JSDOM, VirtualConsole } from "jsdom";

const SIZE_CAP = 8000;

const FORBIDDEN = [
  [/\beval\s*\(/, "uses eval()"],
  [/\bnew\s+Function\s*\(/, "uses new Function()"],
  [/<iframe[\s>]/i, "contains <iframe>"],
  [/<script[^>]+src\s*=/i, "external <script src=...>"],
  [/\bwindow\s*\.\s*parent\b/, "references window.parent"],
  [/\bwindow\s*\.\s*top\b/, "references window.top"],
  [/\blocalStorage\b/, "uses localStorage"],
  [/\bsessionStorage\b/, "uses sessionStorage"],
  [/\bdocument\s*\.\s*cookie\b/, "uses document.cookie"],
  [/\bfetch\s*\(/, "uses fetch()"],
  [/\bXMLHttpRequest\b/, "uses XMLHttpRequest"],
  [/\bimport\s*\(/, "uses dynamic import()"],
  [/\bWebSocket\b/, "uses WebSocket"],
];

export function staticLint(widget) {
  const html = widget.html || "";
  const css = widget.css || "";
  const js = widget.js || "";
  const totalSize = html.length + css.length + js.length;
  if (totalSize > SIZE_CAP) {
    return `size cap exceeded: ${totalSize} chars > ${SIZE_CAP}`;
  }
  const combined = `${html}\n${js}`;
  for (const [re, msg] of FORBIDDEN) {
    if (re.test(combined)) return msg;
  }
  try {
    // Parses without executing — catches SyntaxError.
    // eslint-disable-next-line no-new-func
    new Function(js);
  } catch (e) {
    return `JS syntax: ${e?.message || e}`;
  }
  return null;
}

export async function runtimeCheck(widget, timeoutMs = 1500) {
  const html = widget.html || "";
  const css = widget.css || "";
  const js = widget.js || "";
  const fullDoc = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${html}</body></html>`;

  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (e) => {
    errors.push(`jsdom: ${e?.message || e}`);
  });

  let dom;
  try {
    dom = new JSDOM(fullDoc, {
      runScripts: "outside-only",
      pretendToBeVisual: true,
      virtualConsole,
    });
  } catch (e) {
    return `jsdom init: ${e?.message || e}`;
  }
  const win = dom.window;

  win.addEventListener("error", (e) => {
    errors.push(`runtime: ${e.message || e.error?.message || "unknown error"}`);
  });
  win.addEventListener("unhandledrejection", (e) => {
    errors.push(`unhandled rejection: ${e.reason?.message || e.reason}`);
  });

  try {
    // Wrap script execution in a try so synchronous throws are caught here
    // (since the listener is async and might fire after eval throws).
    win.eval(js);
  } catch (e) {
    errors.push(`script throw: ${e?.message || e}`);
  }

  // Allow setTimeout / requestAnimationFrame ticks to settle.
  await new Promise((r) => setTimeout(r, timeoutMs));

  try {
    dom.window.close();
  } catch {}

  if (errors.length > 0) {
    return errors.slice(0, 3).join("; ");
  }
  return null;
}

/**
 * Returns null if the widget is valid; else a short error string.
 */
export async function validateInteractive(widget) {
  const lintError = staticLint(widget);
  if (lintError) return lintError;
  return await runtimeCheck(widget);
}

export function repairPrompt(widget, errorMsg) {
  return `An interactive HTML+CSS+JS widget you produced failed validation.

Title: ${widget.title || "(none)"}
Description: ${widget.description || "(none)"}

Current source:
<html>
${widget.html || ""}
</html>
<css>
${widget.css || ""}
</css>
<js>
${widget.js || ""}
</js>

Validation error: ${errorMsg}

Fix the widget. Hard rules unchanged:
- Vanilla JS only. No frameworks, no eval, no new Function, no fetch, no
  XMLHttpRequest, no <script src=…>, no <iframe>, no localStorage,
  no window.parent/top.
- All inline. Total html + css + js ≤ ${SIZE_CAP} characters.
- DOM APIs, addEventListener, requestAnimationFrame, setTimeout, Math.

Output ONLY a JSON object on a single line, no prose, no markdown fence:
{"html":"<body content>","css":"<rules>","js":"<script>","height":${widget.height || 320}}`;
}

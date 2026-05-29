// Validation for type="interactive" widgets — used by both backends.
// 1) Static lint (regex + JS parse) — fast.
// 2) Runtime check via jsdom — catches runtime errors that lint misses.
// 3) (optional) Visual render via headless Chrome → screenshot, so a vision
//    model can catch render failures jsdom can't see (jsdom has no CSS layout).

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

// ── Visual render (headless Chrome) ──────────────────────────────────────────
// jsdom has no layout engine, so it cannot see CSS/SVG render breakage. We
// render the widget in real Chrome (reusing the user's installed browser via
// playwright-core's channel:"chrome" — no Chromium download) and screenshot it
// for a vision model. The whole stage self-disables if Chrome isn't available.

// Mirrors the frontend's buildInteractiveDoc (src/App.tsx) so the screenshot
// matches what the learner actually sees.
export function buildInteractiveDoc(html, css, js) {
  const csp =
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:;";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>
:root{color-scheme:light dark}
body{margin:0;padding:14px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;font-size:14px;line-height:1.5;color:#1c1917;background:#fafaf9}
@media (prefers-color-scheme: dark){body{background:#1c1917;color:#fafaf9}}
${css || ""}
</style></head><body>${html || ""}<script>${js || ""}</script></body></html>`;
}

let _chromium = null; // chromium launcher, or false if playwright-core absent
let _browser = null; // cached browser instance (reused across renders)
let _probe = null; // cached availability Promise<boolean>

async function chromiumLauncher() {
  if (_chromium !== null) return _chromium;
  try {
    _chromium = (await import("playwright-core")).chromium;
  } catch {
    _chromium = false;
  }
  return _chromium;
}

async function getBrowser() {
  const chromium = await chromiumLauncher();
  if (!chromium) return null;
  if (_browser && _browser.isConnected()) return _browser;
  try {
    _browser = await chromium.launch({ channel: "chrome", headless: true });
    return _browser;
  } catch (e) {
    process.stderr.write(`[interactive] chrome launch failed: ${e?.message || e}\n`);
    _browser = null;
    return null;
  }
}

// One-time (cached) probe: can we render at all? Lets callers self-disable the
// visual stage when Chrome is missing without throwing.
export async function rendererAvailable() {
  if (_probe === null) _probe = getBrowser().then((b) => !!b);
  return _probe;
}

// Render a widget to a PNG at `outPath`. Returns outPath on success, else null.
export async function renderWidgetPng(widget, outPath) {
  const browser = await getBrowser();
  if (!browser) return null;
  const doc = buildInteractiveDoc(widget.html, widget.css, widget.js);
  const height = Math.max(160, Math.min(640, Number(widget.height) || 320));
  let page;
  try {
    page = await browser.newPage({ viewport: { width: 720, height }, deviceScaleFactor: 2 });
    await page.setContent(doc, { waitUntil: "load" });
    await page.waitForTimeout(450); // let RAF / setTimeout animations settle
    await page.screenshot({ path: outPath, fullPage: true });
    return outPath;
  } catch (e) {
    process.stderr.write(`[interactive] render failed: ${e?.message || e}\n`);
    return null;
  } finally {
    if (page) {
      try {
        await page.close();
      } catch {}
    }
  }
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

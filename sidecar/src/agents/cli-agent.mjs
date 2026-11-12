// Headless CLI transports for the shared stage pipeline.
//
// pipeline.mjs speaks the small Thread interface the Codex SDK exposes:
//   thread.run(prompt, { outputSchema }) -> { finalResponse }
//   thread.runStreamed(prompt, { outputSchema, signal }) -> { events }
//
// This module implements that interface for agents whose only integration
// point is a CLI with a non-interactive mode:
//
//   opencode run --format json                 (prompt on stdin)
//   commandcode -p --output-format json        (prompt on stdin)
//
// Both are used the same way the Codex SDK uses the installed `codex` CLI: the
// user's existing subscription/login is the auth. Isolation mirrors the other
// backends — user plugins/hooks/skills and unrelated MCP servers are disabled,
// only this app's MCP servers are attached, and file writes/shell are denied.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";

import { braveStdioServer } from "../lib/brave.mjs";
import {
  context7StdioServer,
  mediawikiStdioServer,
  researchMcpServersForCategory,
} from "../lib/reference-mcp.mjs";

// A headless agent that prints nothing for this long is treated as hung.
const SILENT_KILL_MS = 10 * 60 * 1000;
const STDERR_TAIL = 4 * 1024;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._/@:+-]*$/;
const DEBUG = process.env.LAA_CLI_DEBUG === "1";
const dbg = (...a) => {
  if (DEBUG) process.stderr.write("[cli-agent] " + a.join(" ") + "\n");
};

const COMMANDS = {
  opencode: {
    env: "LEARN_ANYTHING_OPENCODE_CLI",
    fallback: "opencode",
    install:
      "Install OpenCode (https://opencode.ai) and run `opencode auth login`, then restart the app.",
  },
  commandcode: {
    env: "LEARN_ANYTHING_COMMANDCODE_CLI",
    fallback: "commandcode",
    install:
      "Install Command Code (`npm i -g command-code`) and run `commandcode login`, then restart the app.",
  },
};

function commandFor(backend) {
  const spec = COMMANDS[backend];
  return process.env[spec.env] || spec.fallback;
}

function tail(text, limit = STDERR_TAIL) {
  const s = String(text || "").trim();
  return s.length > limit ? s.slice(-limit) : s;
}

// ── MCP servers ─────────────────────────────────────────────────────────────

/** The stdio MCP servers this app attaches for a stage, in {name:{command,args,env}} form. */
function mcpServersFor(opts = {}) {
  const servers = {};
  if (opts.referenceMcp !== false) {
    Object.assign(servers, {
      context7: context7StdioServer(),
      mediawiki: mediawikiStdioServer(),
      // Domain research servers (arXiv/OpenAlex/Semantic Scholar/YouTube
      // transcripts), gated by category+stage, same as the Codex backend.
      ...researchMcpServersForCategory(opts.category, opts.stage),
    });
  }
  if (opts.braveApiKey) {
    servers.brave = braveStdioServer(opts.braveApiKey);
  }
  // User-attached course MCP servers (already approved in settings).
  if (Array.isArray(opts.customMcp)) {
    for (const s of opts.customMcp) {
      if (!s || typeof s.id !== "string" || typeof s.command !== "string") continue;
      servers[s.id] = {
        command: s.command,
        args: Array.isArray(s.args) ? s.args : [],
        ...(s.env && Object.keys(s.env).length ? { env: s.env } : {}),
      };
    }
  }
  return servers;
}

// ── OpenCode ────────────────────────────────────────────────────────────────

// V1 permission actions. Default-allow (MCP tools are server-defined, so a
// blanket deny hides them), then deny every mutation/execution surface —
// equivalent to the read-only sandbox the Codex backend runs in.
const OPENCODE_PERMISSION = {
  "*": "allow",
  bash: "deny",
  edit: "deny",
  write: "deny",
  patch: "deny",
  multiedit: "deny",
  task: "deny",
  question: "deny",
  plan_enter: "deny",
  plan_exit: "deny",
  webfetch: "allow",
  websearch: "allow",
};

// User-level MCP servers are merged into every OpenCode run. Learn the names
// once so the generated config can switch them off — this is what keeps the
// user's unrelated personal servers from spawning (and hanging) mid-lesson.
let opencodeGlobalMcp = null;
async function opencodeGlobalMcpNames() {
  if (opencodeGlobalMcp) return opencodeGlobalMcp;
  opencodeGlobalMcp = [];
  try {
    const out = await runCapture(commandFor("opencode"), ["debug", "config", "--pure"], {
      timeoutMs: 30_000,
      env: {
        OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
        OPENCODE_DISABLE_CLAUDE_CODE: "1",
        OPENCODE_DISABLE_AUTOUPDATE: "1",
      },
    });
    const start = out.indexOf("{");
    const names = Object.keys(JSON.parse(start >= 0 ? out.slice(start) : out)?.mcp ?? {});
    if (names.length) opencodeGlobalMcp = names;
  } catch {
    /* no global config / not installed yet — nothing to disable */
  }
  return opencodeGlobalMcp;
}

function opencodeConfig(servers, disabledNames) {
  const mcp = {};
  for (const name of disabledNames) mcp[name] = { enabled: false };
  for (const [name, s] of Object.entries(servers)) {
    mcp[name] = {
      type: "local",
      command: [s.command, ...(Array.isArray(s.args) ? s.args : [])],
      enabled: true,
      ...(s.env && Object.keys(s.env).length ? { environment: s.env } : {}),
    };
  }
  return { permission: OPENCODE_PERMISSION, mcp };
}

function reasoningVariant(reasoning) {
  const r = typeof reasoning === "string" ? reasoning.trim().toLowerCase() : "";
  if (!r) return null;
  if (["off", "none", "disabled"].includes(r)) return "none";
  if (r === "max") return "max";
  return r;
}

function opencodeArgs(opts, imagePaths) {
  const args = ["run", "--format", "json", "--pure"];
  const model = typeof opts?.modelConfig?.model === "string" ? opts.modelConfig.model.trim() : "";
  if (model && MODEL_RE.test(model)) args.push("--model", model);
  const variant = reasoningVariant(opts?.modelConfig?.reasoning);
  if (variant) args.push("--variant", variant);
  const dir = Array.isArray(opts?.dirs) ? opts.dirs.find(Boolean) : null;
  if (dir) args.push("--dir", dir);
  for (const path of imagePaths) args.push("-f", path);
  return args;
}

function parseOpencodeLine(line, state) {
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return null;
  }
  if (ev?.type === "text" && ev.part?.type === "text" && typeof ev.part.text === "string") {
    // A text part is a complete assistant message segment. Keep the latest one:
    // intermediate commentary before a tool call must not be concatenated into
    // the final structured answer.
    state.final = ev.part.text;
    return { type: "item.updated", item: { type: "reasoning", text: "" } };
  }
  if (ev?.type === "reasoning" && typeof ev.part?.text === "string") {
    return { type: "item.updated", item: { type: "reasoning", text: ev.part.text } };
  }
  if (ev?.type === "tool_use") {
    const part = ev.part || {};
    const tool = String(part.tool || "tool");
    const input = part.state?.input || {};
    const detail =
      input.query || input.url || input.pattern || input.path || input.command || input.description || "";
    if (/fetch/i.test(tool)) {
      return { type: "item.updated", item: { type: "web_search", query: String(detail) } };
    }
    if (/shell|bash/i.test(tool)) {
      return { type: "item.updated", item: { type: "command_execution", command: String(detail) } };
    }
    return { type: "item.updated", item: { type: "reasoning", text: `${tool}${detail ? `: ${detail}` : ""}` } };
  }
  if (ev?.type === "error") {
    const message =
      ev.error?.data?.message || ev.error?.message || ev.error?.name || "opencode run failed";
    throw new Error(String(message));
  }
  return null;
}

function opencodeEnv(config, workDir) {
  return {
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_SHARE: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DB: join(workDir, "opencode.db"),
  };
}

// ── Command Code ────────────────────────────────────────────────────────────

function commandCodeHome(servers) {
  const home = mkdtempSync(join(tmpdir(), "laa-cmd-"));
  const configDir = join(home, ".commandcode");
  mkdirSync(configDir, { recursive: true });

  // Keep the user's real login; sessions/hooks/settings stay isolated. A
  // symlink also lets the CLI refresh a token in place when needed.
  const auth = join(homedir(), ".commandcode", "auth.json");
  if (existsSync(auth)) {
    const target = join(configDir, "auth.json");
    try {
      symlinkSync(auth, target);
    } catch {
      copyFileSync(auth, target);
    }
  }
  const cache = join(homedir(), ".commandcode", "cache");
  if (existsSync(cache)) {
    try {
      symlinkSync(cache, join(configDir, "cache"), "dir");
    } catch {
      /* cache is optional */
    }
  }

  const mcpServers = {};
  for (const [name, s] of Object.entries(servers)) {
    mcpServers[name] = {
      transport: "stdio",
      enabled: true,
      command: s.command,
      args: Array.isArray(s.args) ? s.args : [],
      ...(s.env && Object.keys(s.env).length ? { env: s.env } : {}),
    };
  }
  if (Object.keys(mcpServers).length) {
    writeFileSync(join(configDir, "mcp.json"), JSON.stringify({ mcpServers }), { mode: 0o600 });
  }
  return home;
}

function commandCodeEffort(reasoning) {
  const r = typeof reasoning === "string" ? reasoning.trim().toLowerCase() : "";
  if (!r) return null;
  if (["off", "none", "disabled", "minimal"].includes(r)) return "low";
  if (r === "xhigh" || r === "max") return "max";
  return r;
}

// Command Code's headless mode treats the current directory as the workspace.
// `--add-dir` is not honoured there (1.88), so pick the narrowest directory that
// contains everything the stage needs and run from it. Writes are still denied
// by the CLI's default headless permission policy.
function commonAncestor(paths) {
  if (!paths.length) return null;
  let common = paths[0];
  for (const path of paths.slice(1)) {
    while (path !== common && !path.startsWith(common + "/") && !path.startsWith(common + "\\")) {
      const parent = dirname(common);
      if (parent === common) break;
      common = parent;
    }
  }
  return common;
}

function commandCodeCwd(opts, imagePaths, fallback) {
  const dirs = Array.isArray(opts?.dirs) ? opts.dirs.filter(Boolean) : [];
  const candidates = [...dirs, ...imagePaths.map((p) => dirname(p))].map((p) => resolve(p));
  return commonAncestor(candidates) || fallback;
}

function commandCodeArgs(opts) {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--no-session",
    "--no-skills",
    "--safe-mode",
    "--no-auto-update",
    "--skip-onboarding",
    // Taste learning writes `.commandcode/taste` into the workspace; a lesson
    // run must never leave files in the learner's space directory.
    "--config",
    "taste-learning=false",
    // Runaway backstop, same intent as the pipeline's agent-turn ceiling.
    "--max-turns",
    "200",
  ];
  const model = typeof opts?.modelConfig?.model === "string" ? opts.modelConfig.model.trim() : "";
  if (model && MODEL_RE.test(model)) args.push("--model", model);
  const effort = commandCodeEffort(opts?.modelConfig?.reasoning);
  if (effort) args.push("--effort", effort);
  const dirs = Array.isArray(opts?.dirs) ? opts.dirs.filter(Boolean) : [];
  for (const dir of dirs) args.push("--add-dir", dir);
  return args;
}

function commandCodeEnv(home) {
  return {
    HOME: home,
    USERPROFILE: home,
    COMMANDCODE_SKIP_UPDATES: "1",
  };
}

function parseCommandCodeLine(line, state) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return null;
  }
  if (msg?.type === "result") {
    if (msg.subtype && msg.subtype !== "success") {
      throw new Error(String(msg.error || msg.subtype));
    }
    if (typeof msg.finalText === "string") state.final = msg.finalText;
    return null;
  }
  if (msg?.type !== "event") return null;
  const ev = msg.event || {};
  if (ev.type === "text_delta" && typeof ev.delta === "string") {
    state.final += ev.delta;
    // Deltas arrive per token; forward at most one liveness event per second so
    // the JSON-RPC progress channel/UI is not flooded.
    const now = Date.now();
    if (now - (state.lastTextProgress || 0) < 1000) return null;
    state.lastTextProgress = now;
    return { type: "item.updated", item: { type: "reasoning", text: "" } };
  }
  if (ev.type === "run_end" && typeof ev.result?.finalText === "string") {
    state.final = ev.result.finalText;
    return null;
  }
  if (ev.type === "tool_use") {
    const name = String(ev.name || "tool");
    const input = ev.input || {};
    const detail =
      input.query || input.url || input.path || input.pattern || input.command || input.description || "";
    if (/web|fetch|search/i.test(name) && !/search_tools/i.test(name)) {
      return { type: "item.updated", item: { type: "web_search", query: String(detail) } };
    }
    if (/bash|shell|exec/i.test(name)) {
      return { type: "item.updated", item: { type: "command_execution", command: String(detail) } };
    }
    if (/^mcp/i.test(name)) {
      return { type: "item.updated", item: { type: "mcp_tool_call", server: name, tool: detail } };
    }
    return { type: "item.updated", item: { type: "reasoning", text: `${name}${detail ? `: ${detail}` : ""}` } };
  }
  if (ev.type === "error") {
    throw new Error(String(ev.message || ev.error?.message || "commandcode run failed"));
  }
  return null;
}

// ── Process plumbing ────────────────────────────────────────────────────────

function spawnOpts(cwd, env) {
  return {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  };
}

// Windows resolves npm's .cmd shims only through cmd.exe, and Node's `shell:
// true` joins args without quoting (breaking paths with spaces). Build one
// quoted command line instead. Prompts travel on stdin, so this only ever
// carries app-controlled flags/paths.
function spawnProcess(command, args, opts) {
  if (process.platform !== "win32") return spawn(command, args, opts);
  const quote = (value) => `"${String(value).replace(/"/g, '\\"')}"`;
  const line = [command, ...args].map(quote).join(" ");
  return spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
    ...opts,
    windowsVerbatimArguments: true,
  });
}

/** Spawn a CLI, resolve with its stdout (used for model listings). */
function runCapture(command, args, { timeoutMs = 60_000, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, spawnOpts(undefined, env));
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (c) => {
      out += c.toString();
    });
    child.stderr.on("data", (c) => {
      err += c.toString();
    });
    child.stdin.on("error", () => {});
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${command} exited with ${code}: ${tail(err)}`));
    });
    child.stdin.end();
  });
}

/**
 * Run one headless CLI turn, yielding Codex-shaped progress events and leaving
 * the final assistant text on `state.final`.
 */
async function* runCliTurn({ command, args, env, cwd, prompt, signal, state, parseLine, label }) {
  dbg("spawn", command, JSON.stringify(args), "cwd=", cwd);
  const child = spawnProcess(command, args, spawnOpts(cwd, env));
  const rl = createInterface({ input: child.stdout });
  let stderr = "";
  let exit = null;
  let spawnError = null;
  let silent = false;

  let watchdog = null;
  const armWatchdog = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      silent = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3_000).unref?.();
    }, SILENT_KILL_MS);
    watchdog.unref?.();
  };
  const onAbort = () => {
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 3_000).unref?.();
  };

  child.stdout.on("data", armWatchdog);
  child.stderr.on("data", (chunk) => {
    armWatchdog();
    if (DEBUG) process.stderr.write("[cli-agent stderr] " + chunk.toString());
    stderr = tail(stderr + chunk.toString());
  });
  child.stdin.on("error", () => {});
  child.on("error", (e) => {
    spawnError = e;
    rl.close();
  });
  signal?.addEventListener("abort", onAbort, { once: true });
  armWatchdog();

  child.stdin.end(prompt);

  try {
    yield { type: "turn.started" };
    for await (const rawLine of rl) {
      const line = rawLine.replace(/\r$/, "").trim();
      if (!line) continue;
      dbg("stdout", line.slice(0, 300));
      const ev = parseLine(line, state);
      if (ev) yield ev;
    }
    exit = await new Promise((resolve) => {
      if (spawnError) return resolve({ code: -1, error: spawnError });
      child.once("close", (code, sig) => resolve({ code, sig }));
      // `close` may already have fired before this listener (readline finished
      // first); check the process state as a fallback.
      if (child.exitCode !== null) resolve({ code: child.exitCode, sig: child.signalCode });
    });
  } finally {
    if (watchdog) clearTimeout(watchdog);
    signal?.removeEventListener("abort", onAbort);
    rl.close();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }

  if (silent) {
    throw new Error(`${label} produced no output for ${Math.round(SILENT_KILL_MS / 60000)} minutes`);
  }
  if (exit?.error?.code === "ENOENT") {
    throw new Error(`${label} CLI is not installed or not visible to the app. ${COMMANDS[state.backend].install}`);
  }
  if (exit?.error) throw exit.error;
  if (exit?.code === 8) {
    throw new Error(`${label} hit its 200-turn ceiling before finishing`);
  }
  if (exit?.code !== 0) {
    throw new Error(`${label} exited with ${exit?.code}: ${tail(stderr) || "no error output"}`);
  }
  if (!state.final.trim()) {
    throw new Error(`${label} returned an empty response${stderr ? `: ${tail(stderr)}` : ""}`);
  }
}

// ── JSON output contract ────────────────────────────────────────────────────

function withSchema(prompt, schema) {
  if (!schema) return prompt;
  return `${prompt}

IMPORTANT: return the answer as a single JSON value that validates against this
JSON Schema. No prose before or after it, no markdown code fences.

<json-schema>
${JSON.stringify(schema)}
</json-schema>`;
}

/** Slice out the JSON value starting at `start`, respecting strings/escapes. */
function sliceJson(text, start) {
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Pull the first JSON value out of a reply that may have prose/fences. */
function extractJsonText(text) {
  const candidates = [];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) candidates.push(fence[1].trim());
  for (const opener of ["{", "["]) {
    const start = text.indexOf(opener);
    if (start < 0) continue;
    const sliced = sliceJson(text, start);
    if (sliced) candidates.push(sliced);
  }
  candidates.push(text.trim());
  for (const c of candidates) {
    try {
      return JSON.stringify(JSON.parse(c));
    } catch {}
  }
  throw new Error(`response did not contain valid JSON: ${text.slice(0, 200)}`);
}

// ── Thread factory ──────────────────────────────────────────────────────────

/**
 * Build a Codex-compatible Thread for a CLI backend.
 * @param {"opencode"|"commandcode"} backend
 * @param {object} opts pipeline options (modelConfig, dirs, category, stage, …)
 */
export function createCliThread(backend, opts = {}) {
  const label = backend === "opencode" ? "OpenCode" : "Command Code";
  const id = randomUUID();
  const imagePaths = Array.isArray(opts.imagePaths)
    ? opts.imagePaths
        .filter((p) => typeof p === "string" && p.trim())
        .map((p) => p.trim())
    : typeof opts.imagePath === "string" && opts.imagePath.trim()
      ? [opts.imagePath.trim()]
      : [];

  async function* events(prompt, runOpts = {}) {
    const servers = mcpServersFor(opts);
    const state = { backend, final: "" };
    const text = withSchema(prompt, runOpts.outputSchema);
    const dirs = Array.isArray(opts.dirs) ? opts.dirs.filter(Boolean) : [];
    for (const path of imagePaths) dirs.push(dirname(path));

    if (backend === "opencode") {
      const workRoot = mkdtempSync(join(tmpdir(), "laa-oc-"));
      try {
        const config = opencodeConfig(servers, await opencodeGlobalMcpNames());
        yield* runCliTurn({
          command: commandFor("opencode"),
          args: opencodeArgs(opts, imagePaths),
          env: opencodeEnv(config, workRoot),
          cwd: dirs[0] || process.cwd(),
          prompt: text,
          signal: runOpts.signal,
          state,
          parseLine: parseOpencodeLine,
          label,
        });
      } finally {
        rmSync(workRoot, { recursive: true, force: true });
      }
    } else {
      const home = commandCodeHome(servers);
      try {
        const args = commandCodeArgs(opts);
        yield* runCliTurn({
          command: commandFor("commandcode"),
          args,
          env: commandCodeEnv(home),
          cwd: commandCodeCwd(opts, imagePaths, home),
          prompt: text,
          signal: runOpts.signal,
          state,
          parseLine: parseCommandCodeLine,
          label,
        });
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }

    const final = runOpts.outputSchema ? extractJsonText(state.final) : state.final;
    yield { type: "item.completed", item: { type: "agent_message", text: final } };
  }

  return {
    id,
    async run(prompt, runOpts = {}) {
      let final = "";
      for await (const ev of events(prompt, runOpts)) {
        if (ev.type === "item.completed" && ev.item?.type === "agent_message") {
          final = ev.item.text;
        }
      }
      return { finalResponse: final };
    },
    runStreamed(prompt, runOpts = {}) {
      return { events: events(prompt, runOpts) };
    },
  };
}

// ── Model catalogs ──────────────────────────────────────────────────────────

let opencodeModels = null;
async function listOpencodeModels() {
  if (opencodeModels) return opencodeModels;
  const out = await runCapture(commandFor("opencode"), ["models", "--verbose"], {
    timeoutMs: 120_000,
    env: {
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
    },
  });
  const lines = out.split("\n");
  const models = [];
  for (let i = 0; i < lines.length; i += 1) {
    const value = lines[i].trim();
    if (!value || !/^[^\s{}]+\/[^\s{}]+$/.test(value) || lines[i + 1]?.trim() !== "{") continue;
    let meta = null;
    let buf = "";
    let end = i + 1;
    for (; end < lines.length; end += 1) {
      buf += (buf ? "\n" : "") + lines[end];
      try {
        meta = JSON.parse(buf);
        break;
      } catch {
        /* keep accumulating until the object is complete */
      }
    }
    const variants = meta?.variants && typeof meta.variants === "object" ? Object.keys(meta.variants) : [];
    models.push({
      value,
      label: meta?.name || value,
      description: meta?.family || "",
      effortLevels: variants,
    });
    i = end;
  }
  opencodeModels = models;
  return opencodeModels;
}

let commandCodeModels = null;
async function listCommandCodeModels() {
  if (commandCodeModels) return commandCodeModels;
  const out = await runCapture(commandFor("commandcode"), ["--list-models"], {
    timeoutMs: 120_000,
    env: { COMMANDCODE_SKIP_UPDATES: "1" },
  });
  const models = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^(\S+)\s{2,}(.+)$/);
    if (!m) continue;
    models.push({
      value: m[1],
      label: m[1],
      description: m[2].trim(),
      effortLevels: ["low", "medium", "high", "max"],
    });
  }
  commandCodeModels = models;
  return commandCodeModels;
}

export async function listCliModels(backend) {
  if (backend === "opencode") return { models: await listOpencodeModels() };
  if (backend === "commandcode") return { models: await listCommandCodeModels() };
  return { models: [] };
}

/** Test hook: forget cached catalogs. */
export function resetCliCaches() {
  opencodeModels = null;
  commandCodeModels = null;
  opencodeGlobalMcp = null;
}

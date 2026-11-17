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
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { braveStdioServer } from "../lib/brave.mjs";
import {
  context7StdioServer,
  mediawikiStdioServer,
  researchMcpServersForCategory,
} from "../lib/reference-mcp.mjs";

// A headless agent that prints nothing for this long is treated as hung.
const SILENT_KILL_MS = 10 * 60 * 1000;
// A hard ceiling for every turn; even a wedged orphan cannot run forever.
const MAX_RUN_MS = 30 * 60 * 1000;
const REAPER_PATH = fileURLToPath(new URL("./reaper.mjs", import.meta.url));
const STDERR_TAIL = 4 * 1024;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._/@:+-]*$/;
const REASONING_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const COMMANDCODE_EFFORT_RE = /^(minimal|low|medium|high|xhigh|max)$/;
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

// Attachments are copied into the run's temporary workspace. This keeps the
// CLI from needing read access to the original (often /tmp) directory and means
// only the learner's space directories are exposed as external roots.
function stageImages(workRoot, imagePaths, text) {
  if (!imagePaths.length) return { text, paths: [] };
  const dir = join(workRoot, "attachments");
  mkdirSync(dir, { recursive: true });
  const paths = [];
  const replacements = [];
  for (let i = 0; i < imagePaths.length; i += 1) {
    const source = imagePaths[i];
    const target = join(dir, `${i}-${basename(source)}`);
    copyFileSync(source, target);
    paths.push(target);
    replacements.push([source, target]);
  }
  let staged = text;
  for (const [source, target] of replacements) staged = staged.split(source).join(target);
  return { text: staged, paths };
}

// MCP environment values are secrets. Put placeholders in the config file and
// the real values in the CLI process environment, which the model cannot read
// (bash/edit are denied) and OpenCode substitutes before spawning the server.
function redactMcpEnv(servers) {
  const env = {};
  const safe = {};
  let index = 0;
  for (const [name, server] of Object.entries(servers)) {
    const values = server?.env && typeof server.env === "object" ? server.env : {};
    const redacted = {};
    for (const [key, value] of Object.entries(values)) {
      const varName = `LAA_OPENCODE_MCP_${index}_${String(key).replace(/[^A-Za-z0-9_]/g, "_")}`;
      index += 1;
      // OpenCode substitutes {env:...} into the config *text* before parsing
      // the JSON, so quotes/backslashes/newlines must already be JSON-escaped.
      env[varName] = JSON.stringify(String(value)).slice(1, -1);
      redacted[key] = `{env:${varName}}`;
    }
    safe[name] = Object.keys(redacted).length ? { ...server, env: redacted } : server;
  }
  return { servers: safe, env };
}

// ── OpenCode ────────────────────────────────────────────────────────────────

function mcpPermissionName(name) {
  // Must match OpenCode's MCP tool naming: sanitize(server) + "_" + sanitize(tool).
  return String(name).replace(/[^A-Za-z0-9_-]/g, "_");
}

// The build agent's permission rules are appended after the user's global
// rules, so these are the last matching rules and cannot be overridden by a
// global `bash: allow` or a wildcard allow. The first rule is the deny-all;
// every entry after it is an explicit capability.
function opencodePermission(servers, dirs, protectedPaths = []) {
  // Use wildcard keys ("**", "read*") instead of exact keys ("*", "read").
  // Exact keys can already exist in the user's global config, in which case a
  // deep merge preserves their earlier position; these keys are new, so they
  // are appended after every global rule and remain last-match-wins.
  const permission = {
    "**": "deny",
    "read*": {
      "*": "allow",
      "*.env": "deny",
      "*.env.*": "deny",
      "*.env.example": "allow",
    },
    "glob*": "allow",
    "grep*": "allow",
    "webfetch*": "allow",
    "websearch*": "allow",
  };

  // The generated config and session DB contain MCP credentials/session data
  // and live outside the cwd; deny them explicitly even if a space directory
  // happens to cover the temp directory.
  for (const path of protectedPaths) {
    const pattern = process.platform === "win32" ? path.replace(/\\/g, "/") : path;
    permission["read*"][pattern] = "deny";
  }

  // MCP tools are server-defined, so allow each attached server explicitly.
  for (const name of Object.keys(servers)) {
    permission[`${mcpPermissionName(name)}_*`] = "allow";
  }

  // External paths are limited to the learner's attached space directories.
  // Attached images are copied into the temporary cwd, so they need no root.
  const roots = new Set();
  for (const dir of dirs) {
    if (typeof dir === "string" && dir.trim()) roots.add(resolve(dir.trim()));
  }
  if (roots.size === 0) {
    permission["external_directory*"] = "deny";
  } else {
    const external = { "*": "deny" };
    for (const root of roots) {
      const pattern = process.platform === "win32" ? root.replace(/\\/g, "/") : root;
      external[`${pattern}/*`] = "allow";
      external[pattern] = "allow";
    }
    permission["external_directory*"] = external;
  }
  return permission;
}

// User-level MCP servers are merged into every OpenCode run. Learn their names
// so the generated config can switch them off. A failed lookup is fatal rather
// than cached as empty: running with the user's personal servers attached is
// worse than failing the stage (headless MCP calls do not prompt).
const MCP_DISCOVERY_TTL_MS = 5 * 60 * 1000;
let opencodeGlobalMcp = null;
let opencodeGlobalMcpAt = 0;
let opencodeGlobalMcpPending = null;
let opencodeVersionCache = null;

function parseJsonObject(out) {
  const text = String(out || "").trim();
  const candidates = [text];
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return null;
}

async function opencodeGlobalMcpNames() {
  if (opencodeGlobalMcp !== null && Date.now() - opencodeGlobalMcpAt < MCP_DISCOVERY_TTL_MS) {
    return opencodeGlobalMcp;
  }
  if (opencodeGlobalMcpPending) return opencodeGlobalMcpPending;
  opencodeGlobalMcpPending = (async () => {
    const outFile = join(tmpdir(), `laa-oc-config-${randomUUID()}.json`);
    try {
      await runCapture(commandFor("opencode"), ["debug", "config", "--pure"], {
        timeoutMs: 30_000,
        stdoutFile: outFile,
        env: {
          OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
          OPENCODE_DISABLE_CLAUDE_CODE: "1",
          OPENCODE_DISABLE_AUTOUPDATE: "1",
        },
      });
      const config = parseJsonObject(readFileSync(outFile, "utf8"));
      if (!config) throw new Error("could not parse `opencode debug config` output");
      const names = config.mcp && typeof config.mcp === "object" ? Object.keys(config.mcp) : [];
      opencodeGlobalMcp = names;
      opencodeGlobalMcpAt = Date.now();
      return names;
    } catch (e) {
      throw new Error(
        `Could not inspect the user OpenCode config (${String(e?.message ?? e)}). ` +
          "Refusing to run OpenCode because personal MCP servers could be attached without permission."
      );
    } finally {
      rmSync(outFile, { force: true });
      opencodeGlobalMcpPending = null;
    }
  })();
  return opencodeGlobalMcpPending;
}

async function opencodeVersion() {
  if (opencodeVersionCache !== null) return opencodeVersionCache;
  let out;
  try {
    out = await runCapture(commandFor("opencode"), ["--version"], {
      timeoutMs: 15_000,
      env: {
        OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
        OPENCODE_DISABLE_CLAUDE_CODE: "1",
        OPENCODE_DISABLE_AUTOUPDATE: "1",
      },
    });
  } catch (e) {
    throw new Error(
      `Could not determine the OpenCode version (${String(e?.message ?? e)}). ${COMMANDS.opencode.install}`
    );
  }
  const match = out.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!match) {
    throw new Error(`Could not determine the OpenCode version from \`opencode --version\`. ${COMMANDS.opencode.install}`);
  }
  const version = { raw: match[0], major: Number(match[1]) };
  opencodeVersionCache = version;
  return version;
}

function opencodeConfig(servers, disabledNames, dirs, agentName, protectedPaths = []) {
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
  return {
    // The top-level rules are a fallback if OpenCode cannot resolve the agent
    // (it falls back to the default agent with a warning). The run-scoped agent
    // is the normal path and cannot collide with a user-defined agent.
    permission: opencodePermission(servers, dirs, protectedPaths),
    agent: { [agentName]: { mode: "primary", permission: opencodePermission(servers, dirs, protectedPaths) } },
    mcp,
  };
}

function reasoningVariant(reasoning, model) {
  const r = typeof reasoning === "string" ? reasoning.trim().toLowerCase() : "";
  if (!r) return null;
  const mapped = ["off", "none", "disabled"].includes(r) ? "none" : r;
  if (!REASONING_RE.test(mapped)) return null;
  // When the catalog is already loaded, only send variants the model declares.
  // Unknown variants are silently ignored by OpenCode, so this avoids no-op
  // thinking levels without an extra CLI call.
  if (opencodeModels) {
    const entry = opencodeModels.find((m) => m.value === model);
    if (entry && !entry.effortLevels.includes(mapped)) return null;
  }
  return mapped;
}

function opencodeArgs(opts, imagePaths, variant, agentName) {
  const args = ["run", "--format", "json", "--pure", "--agent", agentName];
  const model = typeof opts?.modelConfig?.model === "string" ? opts.modelConfig.model.trim() : "";
  if (model && MODEL_RE.test(model)) args.push("--model", model);
  if (variant) args.push("--variant", variant);
  for (const path of imagePaths) args.push("-f", path);
  return args;
}

function appendOpencodeText(state, part) {
  const messageID = typeof part.messageID === "string" ? part.messageID : "";
  if (messageID && state.finalMessageId !== messageID) {
    state.finalMessageId = messageID;
    state.finalParts = [];
    state.final = "";
  }
  state.finalParts ??= [];
  const id = typeof part.id === "string" ? part.id : `part-${state.finalParts.length}`;
  const existing = state.finalParts.find((p) => p.id === id);
  if (existing) existing.text = part.text;
  else state.finalParts.push({ id, text: part.text });
  state.final = state.finalParts.map((p) => p.text).join("");
}

function parseOpencodeLine(line, state) {
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return null;
  }
  if (ev?.type === "text" && ev.part?.type === "text" && typeof ev.part.text === "string") {
    // A long answer can arrive as several text parts in the same assistant
    // message. Concatenate those, but reset when a new message starts so
    // intermediate commentary before a tool call is not included.
    appendOpencodeText(state, ev.part);
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

function opencodeEnv(config, configDir, extraEnv = {}) {
  // Keep MCP credentials out of the process environment: an MCP child can
  // inherit env vars, but it cannot read this 0600 file just by existing.
  // This directory is outside the agent's cwd and its read is denied.
  const configPath = join(configDir, "opencode.json");
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  return {
    ...extraEnv,
    OPENCODE_CONFIG: configPath,
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DB: join(configDir, "opencode.db"),
  };
}

// ── Command Code ────────────────────────────────────────────────────────────

function commandCodeUserPermissions() {
  // Command Code reads deny/ask rules from ~/.commandcode/settings.json. Keep
  // those rules in the isolated HOME, but never copy hooks, MCP servers, or
  // allow rules from the user's config.
  const path = join(homedir(), ".commandcode", "settings.json");
  if (!existsSync(path)) return null;
  try {
    const settings = JSON.parse(readFileSync(path, "utf8"));
    const permissions = settings?.permissions;
    if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) return null;
    const kept = {};
    for (const key of ["deny", "ask", "disableBypass"]) {
      if (permissions[key] !== undefined) kept[key] = permissions[key];
    }
    return Object.keys(kept).length ? kept : null;
  } catch {
    return null;
  }
}

function commandCodeAllowRules(servers) {
  // dont-ask mode only runs tools on this list. Keep it read-only: local file
  // inspection, web research, tool discovery, and the attached MCP servers.
  const rules = [
    "read_file",
    "read_multiple_files",
    "read_directory",
    "glob",
    "grep",
    "get_diagnostics",
    "web_search",
    "web_fetch",
    "search_tools",
  ];
  for (const name of Object.keys(servers)) {
    if (name) rules.push(`mcp__${name}__*`);
  }
  return rules;
}

function commandCodeHome(servers) {
  const home = mkdtempSync(join(tmpdir(), "laa-cmd-"));
  const configDir = join(home, ".commandcode");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(join(home, "workspace"), { recursive: true });

  // Keep the user's real login; sessions/hooks/settings stay isolated. A
  // symlink also lets the CLI refresh a token in place when needed.
  const realHome = homedir();
  const auth = join(realHome, ".commandcode", "auth.json");
  let authCopy = null;
  let authOriginal = null;
  if (existsSync(auth)) {
    const target = join(configDir, "auth.json");
    try {
      symlinkSync(auth, target);
    } catch {
      copyFileSync(auth, target);
      authCopy = target;
      authOriginal = readFileSync(auth);
    }
  }
  const cache = join(realHome, ".commandcode", "cache");
  if (existsSync(cache)) {
    try {
      symlinkSync(cache, join(configDir, "cache"), "dir");
    } catch {
      /* cache is optional */
    }
  }

  const userPermissions = commandCodeUserPermissions();
  const permissions = { allow: commandCodeAllowRules(servers), ...(userPermissions || {}) };
  writeFileSync(join(configDir, "settings.json"), JSON.stringify({ permissions }), { mode: 0o600 });

  const mcpServers = {};
  for (const [name, s] of Object.entries(servers)) {
    const env = { ...(s.env && typeof s.env === "object" ? s.env : {}) };
    // MCP servers run as children of the CLI. They should still see the real
    // home (credentials, npm cache), even though the CLI itself uses the
    // isolated HOME.
    if (!env.HOME) env.HOME = realHome;
    if (!env.USERPROFILE) env.USERPROFILE = realHome;
    mcpServers[name] = {
      transport: "stdio",
      enabled: true,
      command: s.command,
      args: Array.isArray(s.args) ? s.args : [],
      env,
    };
  }
  if (Object.keys(mcpServers).length) {
    writeFileSync(join(configDir, "mcp.json"), JSON.stringify({ mcpServers }), { mode: 0o600 });
  }
  return { home, authCopy, authSource: auth, authOriginal };
}

function writeBackCommandCodeAuth({ authCopy, authSource, authOriginal }) {
  if (!authCopy || !authOriginal) return;
  try {
    // Do not clobber a newer login or another concurrent run: only write when
    // the real file is still exactly what this run started with.
    const current = readFileSync(authSource);
    if (!current.equals(authOriginal)) return;
    const next = readFileSync(authCopy);
    if (next.equals(authOriginal)) return;
    const temp = `${authSource}.laa-${process.pid}-${Date.now()}.tmp`;
    writeFileSync(temp, next, { mode: 0o600 });
    try {
      renameSync(temp, authSource);
    } catch {
      try {
        copyFileSync(temp, authSource);
        chmodSync(authSource, 0o600);
      } finally {
        rmSync(temp, { force: true });
      }
    }
  } catch {
    /* auth refresh is best-effort; never mask the run result */
  }
}

function commandCodeEffort(reasoning) {
  const r = typeof reasoning === "string" ? reasoning.trim().toLowerCase() : "";
  if (!r) return null;
  if (["off", "none", "disabled", "minimal"].includes(r)) return "low";
  if (r === "xhigh" || r === "max") return "max";
  if (!COMMANDCODE_EFFORT_RE.test(r)) return null;
  return r;
}

function commandCodeArgs(opts, addDirs = []) {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--no-session",
    "--no-skills",
    "--safe-mode",
    "--no-auto-update",
    "--skip-onboarding",
    // dont-ask only runs tools on the generated allow list. Plan mode is
    // stronger but hides all MCP tools, which the research stages need.
    "--permission-mode",
    "dont-ask",
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
  const seen = new Set();
  for (const dir of addDirs) {
    if (typeof dir !== "string" || !dir.trim()) continue;
    const value = resolve(dir.trim());
    if (seen.has(value)) continue;
    seen.add(value);
    args.push("--add-dir", value);
  }
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
  if (ev.type === "message_start") {
    // Don't let commentary before a tool call leak into the final answer when
    // the CLI omits the finalText field.
    state.final = "";
    return null;
  }
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
    // POSIX: make the child its own process-group leader so a kill also reaches
    // MCP grandchildren. Windows uses taskkill /T instead.
    detached: process.platform !== "win32",
  };
}

// Windows resolves npm's .cmd shims only through cmd.exe. Node's `shell: true`
// is not safe for arbitrary arguments, so build a cmd.exe command line using
// the escaping rules from cross-spawn (the same approach execa uses). Prompts
// travel on stdin; this only ever carries app-controlled flags and paths.
const CMD_META_RE = /([()\][%!^"`<>&|;, *?])/g;

function escapeCmdCommand(value) {
  return String(value).replace(CMD_META_RE, "^$1");
}

function escapeCmdArgument(value, doubleEscapeMetaChars) {
  let arg = String(value);
  // Backslashes before a quote (and at the end) must be doubled so the target
  // program's argument parser sees the original characters.
  arg = arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  arg = arg.replace(/(?=(\\+?)?)\1$/, "$1$1");
  arg = `"${arg}"`;
  // Escape cmd.exe metacharacters, including %, so they are not expanded.
  arg = arg.replace(CMD_META_RE, "^$1");
  if (doubleEscapeMetaChars) arg = arg.replace(CMD_META_RE, "^$1");
  return arg;
}

function windowsCommandLine(command, args) {
  const isCmdShim = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(command);
  return [escapeCmdCommand(command), ...args.map((arg) => escapeCmdArgument(arg, isCmdShim))].join(" ");
}

function spawnProcess(command, args, opts) {
  if (process.platform !== "win32") return spawn(command, args, opts);
  const line = windowsCommandLine(command, args);
  return spawn(process.env.ComSpec || process.env.comspec || "cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
    ...opts,
    windowsVerbatimArguments: true,
  });
}

/** Start a detached watchdog that kills the CLI group if this sidecar dies. */
function startParentReaper(child) {
  if (!child?.pid) return null;
  try {
    const reaper = spawn(process.execPath, [REAPER_PATH, String(process.pid), String(child.pid)], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    reaper.on("error", (error) => dbg("parent-death reaper failed:", String(error?.message ?? error)));
    reaper.unref();
    return reaper;
  } catch (error) {
    // The hard runtime cap still bounds the child if the watchdog cannot start.
    dbg("parent-death reaper could not start:", String(error?.message ?? error));
    return null;
  }
}

// Windows kill() only terminates cmd.exe, leaving the CLI and its MCP children
// alive. taskkill /T /F takes down the whole tree. On POSIX signal the process
// group leader; escalation sends SIGKILL. Do not rely on the leader still being
// alive: it may have exited while MCP grandchildren remain in its group.
function killProcessTree(child, force = false) {
  if (!child) return;
  if (process.platform === "win32" && child.pid) {
    try {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("error", () => {});
      killer.unref?.();
    } catch {
      try {
        child.kill(force ? "SIGKILL" : "SIGTERM");
      } catch {
        /* already gone */
      }
    }
    return;
  }
  if (child.pid) {
    try {
      process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
      return;
    } catch {
      /* fall back to the direct child */
    }
  }
  if (child.exitCode === null) {
    try {
      child.kill(force ? "SIGKILL" : "SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

function cleanupDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (e) {
    // A leftover temp dir is preferable to masking a successful run or the
    // real error on Windows (open handles) or after an interrupted kill.
    dbg("cleanup failed", dir, String(e?.message ?? e));
  }
}

/** Spawn a CLI, resolve with its stdout (used for model listings). */
function runCapture(command, args, { timeoutMs = 60_000, env = {}, stdoutFile = null } = {}) {
  return new Promise((resolve, reject) => {
    let outFd = null;
    let child;
    try {
      const options = spawnOpts(undefined, env);
      if (stdoutFile) {
        // Some CLIs (OpenCode's debug config) can exit before a pipe drains a
        // large JSON document; a file descriptor makes the writes blocking and
        // avoids a truncated config.
        outFd = openSync(stdoutFile, "w", 0o600);
        options.stdio = ["pipe", outFd, "pipe"];
      }
      child = spawnProcess(command, args, options);
      startParentReaper(child);
    } catch (e) {
      if (outFd !== null) closeSync(outFd);
      reject(e);
      return;
    }
    let out = "";
    let err = "";
    let fdOpen = outFd !== null;
    const closeOut = () => {
      if (!fdOpen) return;
      fdOpen = false;
      closeSync(outFd);
    };
    const timer = setTimeout(() => {
      killProcessTree(child, true);
      closeOut();
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (c) => {
      out += c.toString();
    });
    child.stderr.on("data", (c) => {
      err += c.toString();
    });
    child.stdin.on("error", () => {});
    child.on("error", (e) => {
      clearTimeout(timer);
      closeOut();
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      closeOut();
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
async function* runCliTurn({
  command,
  args,
  env,
  cwd,
  prompt,
  signal,
  state,
  parseLine,
  label,
  maxRuntimeMs = MAX_RUN_MS,
}) {
  dbg("spawn", command, JSON.stringify(args), "cwd=", cwd);
  const child = spawnProcess(command, args, spawnOpts(cwd, env));
  startParentReaper(child);
  const rl = createInterface({ input: child.stdout });
  let stderr = "";
  let exit = null;
  let spawnError = null;
  let silent = false;
  let timedOut = false;

  let watchdog = null;
  const maxTimer = setTimeout(() => {
    timedOut = true;
    killProcessTree(child);
    setTimeout(() => killProcessTree(child, true), 3_000).unref?.();
  }, maxRuntimeMs);
  maxTimer.unref?.();
  const armWatchdog = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      silent = true;
      killProcessTree(child);
      setTimeout(() => killProcessTree(child, true), 3_000).unref?.();
    }, SILENT_KILL_MS);
    watchdog.unref?.();
  };
  const onAbort = () => {
    killProcessTree(child);
    setTimeout(() => killProcessTree(child, true), 3_000).unref?.();
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
  if (signal?.aborted) onAbort();
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
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve({ code: child.exitCode, sig: child.signalCode });
      }
    });
  } finally {
    if (watchdog) clearTimeout(watchdog);
    clearTimeout(maxTimer);
    signal?.removeEventListener("abort", onAbort);
    rl.close();
    // Even when the leader exited normally, MCP grandchildren can outlive it.
    killProcessTree(child, true);
  }

  if (timedOut) {
    throw new Error(`${label} exceeded its ${Math.round(maxRuntimeMs / 60000)} minute runtime limit`);
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

function jsonValueType(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function schemaTypes(schema) {
  const type = schema?.type;
  if (Array.isArray(type)) return new Set(type);
  if (typeof type === "string") return new Set([type]);
  return null;
}

/** Pull the JSON value out of a reply that may have prose, fences, or citations. */
function extractJsonText(text, schema) {
  const raw = String(text ?? "");
  const candidates = [];
  const push = (value, start) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    const offset = value.indexOf(trimmed);
    candidates.push({
      text: trimmed,
      start: start + Math.max(offset, 0),
      end: start + Math.max(offset, 0) + trimmed.length,
    });
  };

  // Try the whole reply first: this handles a JSON string containing a fenced
  // block, and a bare array/object without heuristics touching it.
  push(raw, 0);
  for (const match of raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    const start = match.index + Math.max(match[0].indexOf(match[1]), 0);
    push(match[1], start);
  }
  // Then balanced values. Invalid candidates (a `{brace}` or citation `[1]`
  // in prose) are skipped.
  const starts = [];
  for (let i = 0; i < raw.length && starts.length < 200; i += 1) {
    if (raw[i] === "{" || raw[i] === "[") starts.push(i);
  }
  for (const start of starts) {
    const sliced = sliceJson(raw, start);
    if (sliced) push(sliced, start);
  }

  const allowedTypes = schemaTypes(schema);
  const valid = [];
  for (const candidate of candidates) {
    let parsed;
    try {
      parsed = JSON.parse(candidate.text);
    } catch {
      continue;
    }
    if (allowedTypes && allowedTypes.size > 0 && !allowedTypes.has(jsonValueType(parsed))) {
      continue;
    }
    valid.push({ ...candidate, normalized: JSON.stringify(parsed) });
  }

  // Drop values nested inside another valid value (for example an inner object
  // inside the real outer object). Among the remaining top-level values, take
  // the last one: corrections follow drafts, so the final answer is last.
  const outermost = valid.filter(
    (candidate) =>
      !valid.some(
        (other) =>
          other !== candidate &&
          other.start <= candidate.start &&
          other.end >= candidate.end &&
          (other.start < candidate.start || other.end > candidate.end)
      )
  );
  if (outermost.length > 0) {
    outermost.sort((a, b) => a.start - b.start || a.end - b.end);
    return outermost[outermost.length - 1].normalized;
  }
  throw new Error(`response did not contain valid JSON: ${raw.slice(0, 200)}`);
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
    const agentName = `laa-ro-${id.slice(0, 8)}`;
    const state = { backend, final: "" };
    const text = withSchema(prompt, runOpts.outputSchema);
    const spaceDirs = Array.isArray(opts.dirs) ? opts.dirs.filter(Boolean) : [];

    if (backend === "opencode") {
      const workRoot = mkdtempSync(join(tmpdir(), "laa-oc-"));
      const configRoot = mkdtempSync(join(tmpdir(), "laa-oc-config-"));
      try {
        const version = await opencodeVersion();
        if (version.major >= 2) {
          throw new Error(
            `OpenCode ${version.raw || "v2"} is not supported yet. Install OpenCode 1.x or choose another agent.`
          );
        }
        const staged = stageImages(workRoot, imagePaths, text);
        const redacted = redactMcpEnv(servers);
        const config = opencodeConfig(
          redacted.servers,
          await opencodeGlobalMcpNames(),
          spaceDirs,
          agentName,
          [join(configRoot, "opencode.json"), join(configRoot, "opencode.db")]
        );
        const variant = reasoningVariant(opts?.modelConfig?.reasoning, opts?.modelConfig?.model);
        yield* runCliTurn({
          command: commandFor("opencode"),
          args: opencodeArgs(opts, staged.paths, variant, agentName),
          env: opencodeEnv(config, configRoot, redacted.env),
          // Run in an empty temp directory: the user's project config is
          // disabled, external reads are limited to the attached dirs, and
          // there is no project-local AGENTS.md/.opencode config to inherit.
          cwd: workRoot,
          prompt: staged.text,
          signal: runOpts.signal,
          state,
          parseLine: parseOpencodeLine,
          label,
        });
      } finally {
        cleanupDir(workRoot);
        cleanupDir(configRoot);
      }
    } else {
      const session = commandCodeHome(servers);
      const home = session.home;
      let ok = false;
      try {
        // A temp workspace keeps Command Code away from `/`, $HOME, and any
        // project `.mcp.json`. The real space dirs are granted with --add-dir.
        const cwd = join(home, "workspace");
        const staged = stageImages(cwd, imagePaths, text);
        const args = commandCodeArgs(opts, spaceDirs);
        yield* runCliTurn({
          command: commandFor("commandcode"),
          args,
          env: commandCodeEnv(home),
          cwd,
          prompt: staged.text,
          signal: runOpts.signal,
          state,
          parseLine: parseCommandCodeLine,
          label,
        });
        ok = true;
      } finally {
        // A copied auth file (Windows without symlink privileges) may have
        // been refreshed by the CLI; put the refreshed token back only after a
        // successful, non-aborted run.
        if (ok) writeBackCommandCodeAuth(session);
        cleanupDir(home);
      }
    }

    const final = runOpts.outputSchema ? extractJsonText(state.final, runOpts.outputSchema) : state.final;
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

/** Test hook: forget cached catalogs and discovery results. */
export function resetCliCaches() {
  opencodeModels = null;
  commandCodeModels = null;
  opencodeGlobalMcp = null;
  opencodeGlobalMcpAt = 0;
  opencodeGlobalMcpPending = null;
  opencodeVersionCache = null;
}

/** Internal hooks for the sidecar transport tests. */
export const __test = {
  parseOpencodeLine,
  parseCommandCodeLine,
  extractJsonText,
  opencodePermission,
  opencodeConfig,
  opencodeArgs,
  opencodeGlobalMcpNames,
  redactMcpEnv,
  opencodeVersion,
  reasoningVariant,
  commandCodeEffort,
  commandCodeArgs,
  commandCodeAllowRules,
  windowsCommandLine,
  runCliTurn,
  MAX_RUN_MS,
};

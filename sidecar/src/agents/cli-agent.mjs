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
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
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

// ── OpenCode ────────────────────────────────────────────────────────────────

function mcpPermissionName(name) {
  // Must match OpenCode's MCP tool naming: sanitize(server) + "_" + sanitize(tool).
  return String(name).replace(/[^A-Za-z0-9_-]/g, "_");
}

// The build agent's permission rules are appended after the user's global
// rules, so these are the last matching rules and cannot be overridden by a
// global `bash: allow` or a wildcard allow. The first rule is the deny-all;
// every entry after it is an explicit capability.
function opencodePermission(servers, dirs) {
  const permission = {
    "*": "deny",
    edit: "deny",
    bash: "deny",
    task: "deny",
    question: "deny",
    plan_enter: "deny",
    plan_exit: "deny",
    skill: "deny",
    read: {
      "*": "allow",
      "*.env": "deny",
      "*.env.*": "deny",
      "*.env.example": "allow",
    },
    glob: "allow",
    grep: "allow",
    webfetch: "allow",
    websearch: "allow",
  };

  // MCP tools are server-defined, so allow each attached server explicitly.
  for (const name of Object.keys(servers)) {
    permission[`${mcpPermissionName(name)}_*`] = "allow";
  }

  // External paths are limited to the learner's attached space directories and
  // the directory holding an attached image. Everything else stays denied.
  const roots = new Set();
  for (const dir of dirs) {
    if (typeof dir === "string" && dir.trim()) roots.add(resolve(dir.trim()));
  }
  if (roots.size === 0) {
    permission.external_directory = "deny";
  } else {
    const external = { "*": "deny" };
    for (const root of roots) {
      external[`${root}/*`] = "allow";
      external[root] = "allow";
    }
    permission.external_directory = external;
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
  let raw = "";
  let major = 0;
  try {
    const out = await runCapture(commandFor("opencode"), ["--version"], {
      timeoutMs: 15_000,
      env: {
        OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
        OPENCODE_DISABLE_CLAUDE_CODE: "1",
        OPENCODE_DISABLE_AUTOUPDATE: "1",
      },
    });
    const match = out.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
    if (match) {
      raw = match[0];
      major = Number(match[1]);
    }
  } catch {
    /* the run itself will report a missing/broken CLI */
  }
  opencodeVersionCache = { raw, major };
  return opencodeVersionCache;
}

function opencodeConfig(servers, disabledNames, dirs, agentName) {
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
    // A per-run agent name cannot collide with a user-defined agent, so the
    // generated permission list is the only one applied to this run.
    agent: { [agentName]: { mode: "primary", permission: opencodePermission(servers, dirs) } },
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

function opencodeEnv(config, workDir) {
  return {
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DB: join(workDir, "opencode.db"),
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

function commandCodeHome(servers) {
  const home = mkdtempSync(join(tmpdir(), "laa-cmd-"));
  const configDir = join(home, ".commandcode");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(join(home, "workspace"), { recursive: true });

  // Keep the user's real login; sessions/hooks/settings stay isolated. A
  // symlink also lets the CLI refresh a token in place when needed.
  const realHome = homedir();
  const auth = join(realHome, ".commandcode", "auth.json");
  if (existsSync(auth)) {
    const target = join(configDir, "auth.json");
    try {
      symlinkSync(auth, target);
    } catch {
      copyFileSync(auth, target);
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
  if (userPermissions) {
    writeFileSync(join(configDir, "settings.json"), JSON.stringify({ permissions: userPermissions }), {
      mode: 0o600,
    });
  }

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
  return home;
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
    // Read-only mode: the headless blocklist only covers a handful of tools,
    // while plan mode denies writes/shell across the whole tool surface.
    "--permission-mode",
    "plan",
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

// Windows kill() only terminates cmd.exe, leaving the CLI and its MCP children
// alive. taskkill /T /F takes down the whole tree. On POSIX signal the process
// group leader; escalation sends SIGKILL.
function killProcessTree(child, force = false) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      child.kill();
    }
    return;
  }
  child.kill(force ? "SIGKILL" : "SIGTERM");
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
    signal?.removeEventListener("abort", onAbort);
    rl.close();
    if (child.exitCode === null) killProcessTree(child, true);
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
  // Try the whole reply first: this handles a JSON string containing a fenced
  // block, and a bare array/object without heuristics touching it.
  const candidates = [raw.trim()];
  for (const match of raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    candidates.push(match[1].trim());
  }
  // Then balanced values. Scanning left-to-right tries the outer object before
  // nested fragments; invalid candidates (a `{brace}` or citation `[1]` in
  // prose) are skipped.
  const starts = [];
  for (let i = 0; i < raw.length && starts.length < 200; i += 1) {
    if (raw[i] === "{" || raw[i] === "[") starts.push(i);
  }
  for (const start of starts) {
    const sliced = sliceJson(raw, start);
    if (sliced) candidates.push(sliced);
  }
  const allowedTypes = schemaTypes(schema);
  const seen = new Set();
  let best = null;
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    let parsed;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (allowedTypes && allowedTypes.size > 0 && !allowedTypes.has(jsonValueType(parsed))) {
      continue;
    }
    const normalized = JSON.stringify(parsed);
    // Prefer the largest matching value. This skips short valid fragments in
    // prose (for example a citation `[1]`) and keeps an outer object over a
    // nested one.
    if (!best || normalized.length > best.length) best = normalized;
  }
  if (best) return best;
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
      try {
        const version = await opencodeVersion();
        if (version.major >= 2) {
          throw new Error(
            `OpenCode ${version.raw || "v2"} is not supported yet. Install OpenCode 1.x or choose another agent.`
          );
        }
        const staged = stageImages(workRoot, imagePaths, text);
        const config = opencodeConfig(servers, await opencodeGlobalMcpNames(), spaceDirs, agentName);
        const variant = reasoningVariant(opts?.modelConfig?.reasoning, opts?.modelConfig?.model);
        yield* runCliTurn({
          command: commandFor("opencode"),
          args: opencodeArgs(opts, staged.paths, variant, agentName),
          env: opencodeEnv(config, workRoot),
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
      }
    } else {
      const home = commandCodeHome(servers);
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
      } finally {
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
  reasoningVariant,
  commandCodeEffort,
  commandCodeArgs,
  windowsCommandLine,
};

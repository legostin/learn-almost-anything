// Stages the sidecar into src-tauri/sidecar/ so Tauri's `bundle.resources`
// can pick it up. The staged node_modules uses pnpm's hoisted linker: the
// default pnpm symlink layout is not preserved reliably inside macOS bundles.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const src = join(repoRoot, "sidecar");
const dest = join(repoRoot, "src-tauri", "sidecar");

if (!existsSync(src)) {
  console.error(`[copy-sidecar] missing source: ${src}`);
  process.exit(1);
}

if (existsSync(dest)) {
  rmSync(dest, { recursive: true, force: true });
}

// Skip dev scratch files like _vtest.mjs / _atest.mjs and any logs.
function include(p) {
  const rel = p.slice(src.length).split(sep).join("/");
  if (rel === "" || rel === "/") return true;
  if (rel === "/node_modules" || rel.startsWith("/node_modules/")) return false;
  if (rel.startsWith("/_")) return false;
  if (rel.endsWith(".log")) return false;
  return true;
}

cpSync(src, dest, {
  recursive: true,
  errorOnExist: false,
  filter: (s) => include(s),
});

const install = spawnSync(
  "pnpm",
  ["install", "--prod", "--frozen-lockfile", "--config.node-linker=hoisted"],
  {
    cwd: dest,
    stdio: "inherit",
    shell: process.platform === "win32",
    windowsHide: true,
  },
);

if (install.error) {
  console.error(`[copy-sidecar] pnpm install could not start: ${install.error.message}`);
}

if (install.status !== 0) {
  console.error(`[copy-sidecar] pnpm install failed in ${dest}`);
  process.exit(install.status ?? 1);
}

let removed = 0;

function removeIfExists(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return;
  }
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    rmSync(path, { recursive: true, force: true });
  } else {
    unlinkSync(path);
  }
  removed++;
}

function pruneScopedPackages(scope, shouldRemove) {
  const scopeDir = join(dest, "node_modules", scope);
  if (!existsSync(scopeDir)) return;
  for (const name of readdirSync(scopeDir)) {
    if (shouldRemove(name)) {
      removeIfExists(join(scopeDir, name));
    }
  }
}

// The app must use the user's logged-in Claude Code / Codex CLI. Shipping the
// SDKs' native CLI packages inside the notarized .app makes macOS treat those
// nested executables as separate quarantined tools, and they do not carry the
// user's subscription login anyway.
pruneScopedPackages("@openai", (name) => name === "codex" || /^codex-(darwin|linux|win32)-/.test(name));
pruneScopedPackages("@anthropic-ai", (name) => /^claude-agent-sdk-(darwin|linux|win32)-/.test(name));

for (const name of ["codex", "codex.cmd", "codex.ps1", "claude", "claude.cmd", "claude.ps1"]) {
  removeIfExists(join(dest, "node_modules", ".bin", name));
}

if (removed > 0) {
  console.log(`[copy-sidecar] pruned ${removed} bundled agent CLI path(s)`);
}

console.log(`[copy-sidecar] staged hoisted sidecar -> ${dest}`);

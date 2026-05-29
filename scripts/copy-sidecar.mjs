// Copies the sidecar (source + node_modules) into src-tauri/sidecar/ so the
// Tauri bundle's `resources` glob can pick it up. Runs as part of `pnpm build`
// before `tauri build` packages everything.
//
// pnpm's node_modules layout uses symlinks into .pnpm/ — we dereference so the
// resulting tree is self-contained inside the bundle.

import { cpSync, existsSync, rmSync } from "node:fs";
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
  if (rel.startsWith("/_")) return false;
  if (rel.endsWith(".log")) return false;
  return true;
}

cpSync(src, dest, {
  recursive: true,
  dereference: true,
  errorOnExist: false,
  filter: (s) => include(s),
});

console.log(`[copy-sidecar] copied → ${dest}`);

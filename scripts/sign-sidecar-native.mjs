// Signs native code staged under src-tauri/sidecar before Tauri copies it into
// the macOS .app bundle. Apple notarization rejects unsigned nested Mach-O
// binaries in bundle resources.

import { existsSync, lstatSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const enabled = process.env.SIGN_SIDECAR_NATIVE === "1";
const identity = process.env.APPLE_SIGNING_IDENTITY;
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const sidecar = join(repoRoot, "src-tauri", "sidecar");

if (!enabled) {
  console.log("[sign-sidecar-native] skipped (SIGN_SIDECAR_NATIVE is not 1)");
  process.exit(0);
}

if (process.platform !== "darwin") {
  console.log("[sign-sidecar-native] skipped (not macOS)");
  process.exit(0);
}

if (!identity) {
  console.error("[sign-sidecar-native] missing APPLE_SIGNING_IDENTITY");
  process.exit(1);
}

if (!existsSync(sidecar)) {
  console.error(`[sign-sidecar-native] missing sidecar: ${sidecar}`);
  process.exit(1);
}

function collectCandidates(root) {
  const candidates = [];
  const stack = [root];

  while (stack.length) {
    const dir = stack.pop();
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const st = lstatSync(path);

      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        stack.push(path);
        continue;
      }

      const executable = (st.mode & 0o111) !== 0;
      if (executable || path.endsWith(".node") || path.endsWith(".dylib") || path.endsWith(".so")) {
        candidates.push(path);
      }
    }
  }

  return candidates;
}

function isMachO(path) {
  const result = spawnSync("file", ["-b", path], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`file failed for ${path}: ${result.stderr || result.stdout}`);
  }
  return result.stdout.includes("Mach-O");
}

let signed = 0;
const failures = [];

for (const path of collectCandidates(sidecar)) {
  if (!isMachO(path)) continue;

  const result = spawnSync(
    "codesign",
    ["--force", "--options", "runtime", "--timestamp", "--sign", identity, path],
    { encoding: "utf8" },
  );

  if (result.status !== 0) {
    failures.push({ path, output: result.stderr || result.stdout });
    continue;
  }

  signed++;
}

if (failures.length) {
  console.error(`[sign-sidecar-native] failed to sign ${failures.length} file(s)`);
  for (const failure of failures) {
    console.error(`\n## ${failure.path}\n${failure.output}`);
  }
  process.exit(1);
}

console.log(`[sign-sidecar-native] signed ${signed} Mach-O file(s) under ${sidecar}`);

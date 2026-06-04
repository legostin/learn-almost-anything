#!/usr/bin/env node
// Auto-release hook: when the work is finished and there are unreleased
// *product* changes, cut the next patch release.
//
// Wired as a Claude Code Stop hook (.claude/settings.local.json). It runs after
// every assistant turn and is a strict no-op unless ALL of these hold:
//   - current branch is `main`
//   - the working tree is clean (changes are committed = "finished")
//   - there are commits since the latest vX.Y.Z tag whose subject is a
//     conventional `feat:` or `fix:` (i.e. a product change, not a chore)
// Then it bumps the patch version across the 4 manifests, commits
// `release: prepare vX.Y.Z+1`, tags it, and pushes — which triggers the
// GitHub Release workflow. Anything unexpected → silent exit 0 (never blocks
// the session, never loops).

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const sh = (cmd) => execSync(cmd, { cwd: ROOT, encoding: "utf8" }).trim();
const PRODUCT_RE = /^(feat|fix)(\(.+\))?!?:/;

function bumpPatch(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) return null;
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

function replaceOnce(file, find, next) {
  const p = `${ROOT}/${file}`;
  const before = readFileSync(p, "utf8");
  if (!before.includes(find)) throw new Error(`${file}: missing "${find}"`);
  writeFileSync(p, before.replace(find, next));
}

try {
  // Guard rails — bail quietly on anything that isn't "finished product work".
  if (sh("git rev-parse --abbrev-ref HEAD") !== "main") process.exit(0);
  if (sh("git status --porcelain")) process.exit(0); // uncommitted = not finished

  let tag;
  try {
    tag = sh("git describe --tags --match 'v[0-9]*' --abbrev=0");
  } catch {
    process.exit(0); // no version tags yet — don't guess
  }

  const subjects = sh(`git log ${tag}..HEAD --format=%s`)
    .split("\n")
    .filter(Boolean);
  if (subjects.length === 0) process.exit(0); // nothing new since the release
  if (!subjects.some((s) => PRODUCT_RE.test(s))) process.exit(0); // only chores

  const cur = JSON.parse(readFileSync(`${ROOT}/package.json`, "utf8")).version;
  const next = bumpPatch(cur);
  if (!next) process.exit(0);

  replaceOnce("package.json", `"version": "${cur}"`, `"version": "${next}"`);
  replaceOnce("src-tauri/tauri.conf.json", `"version": "${cur}"`, `"version": "${next}"`);
  replaceOnce("src-tauri/Cargo.toml", `version = "${cur}"`, `version = "${next}"`);
  replaceOnce(
    "src-tauri/Cargo.lock",
    `name = "learn-almost-anything"\nversion = "${cur}"`,
    `name = "learn-almost-anything"\nversion = "${next}"`
  );

  const product = subjects.filter((s) => PRODUCT_RE.test(s));
  const body = product.map((s) => `- ${s}`).join("\n");
  const msg = `release: prepare v${next}\n\nAuto-release of finished product changes:\n${body}\n\nBump app version to v${next}.`;

  sh("git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock");
  execSync(`git commit -F -`, { cwd: ROOT, input: msg });
  sh(`git tag -a v${next} -m "v${next}"`);
  sh("git push origin main");
  sh(`git push origin v${next}`);

  console.log(`[auto-release] cut v${next} (${product.length} product change(s) since ${tag})`);
} catch (e) {
  // Never break the session or loop the model.
  console.error(`[auto-release] skipped: ${e?.message ?? e}`);
}
process.exit(0);

// Run at the end of `pnpm build`, just before Tauri's cargo build script
// reads bundle.resources. If src-tauri/sidecar/ is empty or missing here, the
// resource resolution will fail with the cryptic "path not found" — this
// script catches that early with a useful message.

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const target = process.env.SIDECAR_DIR || join(root, "src-tauri", "sidecar");

function countFiles(p) {
  let n = 0;
  for (const e of readdirSync(p)) {
    const sub = join(p, e);
    const st = lstatSync(sub);
    if (st.isSymbolicLink()) n++;
    else if (st.isDirectory()) n += countFiles(sub);
    else n++;
  }
  return n;
}

if (!existsSync(target)) {
  console.error(`[verify-sidecar] FAIL: ${target} does not exist`);
  process.exit(1);
}

const required = ["src/index.mjs", "node_modules", "package.json"];
let missing = required.filter((p) => !existsSync(join(target, p)));
if (missing.length) {
  console.error(`[verify-sidecar] FAIL: missing ${missing.join(", ")} under ${target}`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
for (const name of Object.keys(pkg.dependencies || {})) {
  required.push(join("node_modules", name, "package.json"));
}

missing = required.filter((p) => !existsSync(join(target, p)));
if (missing.length) {
  console.error(`[verify-sidecar] FAIL: missing ${missing.join(", ")} under ${target}`);
  process.exit(1);
}

const ping = spawnSync(process.execPath, [join(target, "src", "index.mjs")], {
  input: JSON.stringify({ id: "verify", method: "ping", params: {} }) + "\n",
  encoding: "utf8",
  timeout: 10000,
});

if (ping.status !== 0 || !ping.stdout.includes('"pong":true')) {
  console.error(`[verify-sidecar] FAIL: sidecar ping failed under ${target}`);
  if (ping.stdout) console.error(ping.stdout.trim());
  if (ping.stderr) console.error(ping.stderr.trim());
  process.exit(ping.status || 1);
}

const files = countFiles(target);
console.log(`[verify-sidecar] OK: ${files} files staged under ${target}`);

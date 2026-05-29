// Brave Search MCP server launch config.
//
// The server is a project dependency, so we resolve its installed entry and
// spawn it directly with this Node binary — avoiding a per-call `npx` registry
// resolution (network round-trip + cold start) on every draft. Falls back to
// `npx` if resolution fails, so web search keeps working regardless.

import { createRequire } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import process from "node:process";

const PKG = "@modelcontextprotocol/server-brave-search";

let cached = null;

function resolveLaunch() {
  if (cached) return cached;
  try {
    const require = createRequire(import.meta.url);
    const pkgJsonPath = require.resolve(`${PKG}/package.json`);
    const pkg = require(`${PKG}/package.json`);
    const binRel =
      typeof pkg.bin === "string"
        ? pkg.bin
        : Object.values(pkg.bin || {})[0] || pkg.main || "index.js";
    const entry = resolvePath(dirname(pkgJsonPath), binRel);
    cached = { command: process.execPath, args: [entry] };
  } catch {
    cached = { command: "npx", args: ["-y", PKG] };
  }
  return cached;
}

// Returns { command, args, env } for a stdio MCP server. Callers add a `type`
// field if their MCP client requires it.
export function braveStdioServer(braveApiKey) {
  const { command, args } = resolveLaunch();
  return { command, args, env: { BRAVE_API_KEY: braveApiKey } };
}

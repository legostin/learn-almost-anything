// Built-in read-only/reference MCP server launch configs.

import { createRequire } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const HERE = dirname(fileURLToPath(import.meta.url));
const MEDIAWIKI_CONFIG = resolvePath(HERE, "mediawiki.config.json");
const MEDIAWIKI_READONLY_PROXY = resolvePath(HERE, "mediawiki-readonly-proxy.mjs");

const cache = new Map();

function resolveLaunch(pkgName) {
  if (cache.has(pkgName)) return cache.get(pkgName);
  let launch;
  try {
    const require = createRequire(import.meta.url);
    const pkgJsonPath = require.resolve(`${pkgName}/package.json`);
    const pkg = require(`${pkgName}/package.json`);
    const binRel =
      typeof pkg.bin === "string"
        ? pkg.bin
        : Object.values(pkg.bin || {})[0] || pkg.main || "index.js";
    launch = { command: process.execPath, args: [resolvePath(dirname(pkgJsonPath), binRel)] };
  } catch {
    launch = { command: "npx", args: ["-y", pkgName] };
  }
  cache.set(pkgName, launch);
  return launch;
}

export function context7StdioServer() {
  const { command, args } = resolveLaunch("@upstash/context7-mcp");
  return { command, args };
}

export function mediawikiUpstreamStdioServer() {
  const { command, args } = resolveLaunch("@professional-wiki/mediawiki-mcp-server");
  return {
    command,
    args,
    env: {
      CONFIG: MEDIAWIKI_CONFIG,
      MCP_LOG_LEVEL: "warning",
    },
  };
}

export function mediawikiStdioServer() {
  return { command: process.execPath, args: [MEDIAWIKI_READONLY_PROXY] };
}

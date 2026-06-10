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

// ── Domain research MCPs (keyless, read-only) ───────────────────────────────

export function arxivStdioServer() {
  const { command, args } = resolveLaunch("@cyanheads/arxiv-mcp-server");
  return { command, args, env: { MCP_TRANSPORT_TYPE: "stdio", MCP_LOG_LEVEL: "warning" } };
}

export function openalexStdioServer() {
  const { command, args } = resolveLaunch("openalex-research-mcp");
  return { command, args };
}

export function semanticScholarStdioServer() {
  const { command, args } = resolveLaunch("@xbghc/semanticscholar-mcp");
  return { command, args };
}

export function youtubeTranscriptStdioServer() {
  const { command, args } = resolveLaunch("@fabriqa.ai/youtube-transcript-mcp");
  return { command, args };
}

/** Categories whose claims should be grounded in the scientific literature. */
const SCIENCE_CATEGORIES = ["data_ai", "science_math", "engineering", "health"];
/** Categories where lessons lean on video material worth transcript-checking. */
const VIDEO_CATEGORIES = ["arts_design", "music", "lifestyle", "language"];

/**
 * Domain research MCP servers to grant for a given course category and
 * pipeline stage ("structure" | "draft" | "verify"). The science pack is
 * always granted at the structure stage (category is unknown until the
 * structure agent returns, and it's one call per course); afterwards servers
 * are category-gated to keep per-draft spawn overhead low. Returns
 * { name: {command,args,env?} } — empty object when none apply.
 */
export function researchMcpServersForCategory(category, stage) {
  const out = {};
  const science = stage === "structure" || SCIENCE_CATEGORIES.includes(category);
  if (science) {
    out.arxiv = arxivStdioServer();
    out.openalex = openalexStdioServer();
    out.semanticscholar = semanticScholarStdioServer();
  }
  if (stage === "draft" && VIDEO_CATEGORIES.includes(category)) {
    out.ytt = youtubeTranscriptStdioServer();
  }
  return out;
}

/** Per-server tool allowlists for the Claude SDK (codex namespaces automatically). */
export const RESEARCH_MCP_ALLOWED_TOOLS = {
  arxiv: [
    "mcp__arxiv__arxiv_search",
    "mcp__arxiv__arxiv_get_metadata",
    "mcp__arxiv__arxiv_read_paper",
    "mcp__arxiv__arxiv_list_categories",
  ],
  openalex: [
    "mcp__openalex__search_works",
    "mcp__openalex__get_work",
    "mcp__openalex__get_related_works",
    "mcp__openalex__search_by_topic",
  ],
  semanticscholar: [
    "mcp__semanticscholar__search_papers",
    "mcp__semanticscholar__get_paper",
    "mcp__semanticscholar__get_paper_citations",
    "mcp__semanticscholar__get_paper_references",
  ],
  ytt: ["mcp__ytt__get-transcript", "mcp__ytt__get-transcript-languages"],
};

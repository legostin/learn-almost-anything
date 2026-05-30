#!/usr/bin/env node
// Read-only facade for the upstream MediaWiki MCP server.
//
// The upstream server hides most write tools when every wiki is read-only, but
// currently still advertises `move-page`. This proxy exposes only the read tools
// the course generator needs, so Codex cannot discover or call mutating tools.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

import { mediawikiUpstreamStdioServer } from "./reference-mcp.mjs";

const READ_TOOLS = new Set([
  "compare-pages",
  "get-category-members",
  "get-file",
  "get-links-here",
  "get-page",
  "get-page-history",
  "get-pages",
  "get-recent-changes",
  "get-revision",
  "get-site-info",
  "list-wikis",
  "parse-wikitext",
  "search-page",
  "search-page-by-prefix",
]);

let upstreamClientPromise = null;

async function upstreamClient() {
  if (!upstreamClientPromise) {
    upstreamClientPromise = (async () => {
      const client = new Client(
        { name: "learn-anything-mediawiki-readonly-proxy", version: "0.1.0" },
        { capabilities: {} }
      );
      await client.connect(new StdioClientTransport(mediawikiUpstreamStdioServer()));
      return client;
    })();
  }
  return upstreamClientPromise;
}

const server = new Server(
  { name: "learn-anything-mediawiki-readonly", version: "0.1.0" },
  {
    capabilities: { tools: {} },
    instructions:
      "Read-only Wikimedia/MediaWiki tools for Commons, English Wikipedia, and Russian Wikipedia.",
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const client = await upstreamClient();
  const result = await client.listTools();
  return {
    tools: result.tools
      .filter((tool) => READ_TOOLS.has(tool.name))
      .map((tool) => ({
        ...tool,
        annotations: { ...(tool.annotations || {}), readOnlyHint: true },
      })),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params?.name;
  if (!READ_TOOLS.has(toolName)) {
    throw new McpError(ErrorCode.MethodNotFound, `Tool "${toolName}" is not exposed by this read-only proxy.`);
  }
  const client = await upstreamClient();
  return await client.callTool(request.params);
});

const transport = new StdioServerTransport();
await server.connect(transport);

async function shutdown() {
  try {
    const client = await upstreamClientPromise;
    await client?.close();
  } catch {
    // Process shutdown path; no useful recovery.
  }
}

process.on("SIGINT", async () => {
  await shutdown();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await shutdown();
  process.exit(0);
});

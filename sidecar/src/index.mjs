// Learn Anything sidecar — JSON-RPC over stdio.
//
// Protocol (line-delimited JSON, one message per line):
//   Request:   { "id": <string>, "method": <string>, "params": <object> }
//   Response:  { "id": <string>, "result": <any> }
//   Error:     { "id": <string>, "error": <string> }
//   Progress:  { "progress": { "id": <string>, "label": <string>, "detail"?: <string> } }
//     — sent zero or more times BEFORE the matching Response, for live UI status
//
// Stdout = protocol channel only. All diagnostics go to stderr.
//
// Backend selection: methods that hit an LLM accept `backend: "claude" | "codex"`
// in params. Defaults to "claude". The dispatcher routes to the right module.

import { createInterface } from "node:readline";
import process from "node:process";

import * as claude from "./agents/claude.mjs";
import * as codex from "./agents/codex.mjs";

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const log = (...args) => process.stderr.write("[sidecar] " + args.join(" ") + "\n");

const agents = { claude, codex };

function pickAgent(params) {
  const name = params?.backend ?? "claude";
  if (!agents[name]) throw new Error(`unknown backend: ${name}`);
  return agents[name];
}

const methods = {
  ping: async () => ({ pong: true, time: Date.now() }),
  chat: async (params) => pickAgent(params).chat(params),
  wizard_questions: async (params) => pickAgent(params).wizardQuestions(params),
  build_structure: async (params) => pickAgent(params).buildStructure(params),
  refine_structure: async (params) => pickAgent(params).refineStructure(params),
  generate_submodule: async (params) => pickAgent(params).generateSubmodule(params),
  submodule_draft: async (params, ctx) => pickAgent(params).submoduleDraft(params, ctx),
  submodule_review: async (params, ctx) => pickAgent(params).submoduleReview(params, ctx),
  submodule_annotate: async (params, ctx) => pickAgent(params).submoduleAnnotate(params, ctx),
  submodule_review_images: async (params, ctx) => pickAgent(params).reviewImages(params, ctx),
  // Back-compat for the dev SmokeTest (always Claude).
  claude_chat: async (params) => claude.chat(params),
};

const rl = createInterface({ input: process.stdin });

let inflight = 0;
let stdinClosed = false;

const maybeExit = () => {
  if (stdinClosed && inflight === 0) {
    log("stdin closed, no in-flight, exiting");
    process.exit(0);
  }
};

rl.on("line", async (line) => {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch (e) {
    log("invalid JSON:", line.slice(0, 200));
    return;
  }
  const { id, method, params } = req;
  if (typeof id !== "string" || typeof method !== "string") {
    send({ id: id ?? null, error: "request requires string id and method" });
    return;
  }
  const handler = methods[method];
  if (!handler) {
    send({ id, error: `unknown method: ${method}` });
    return;
  }
  inflight++;
  const ctx = {
    progress(payload) {
      if (!payload) return;
      send({
        progress: {
          id,
          label: String(payload.label ?? ""),
          ...(payload.detail !== undefined ? { detail: String(payload.detail) } : {}),
        },
      });
    },
  };
  try {
    const result = await handler(params ?? {}, ctx);
    send({ id, result });
  } catch (e) {
    log("handler error for", method, "—", e?.stack || String(e));
    send({ id, error: String(e?.message ?? e) });
  } finally {
    inflight--;
    maybeExit();
  }
});

rl.on("close", () => {
  stdinClosed = true;
  maybeExit();
});

log("ready");

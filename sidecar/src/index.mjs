// Learn Anything sidecar — JSON-RPC over stdio.
//
// Protocol (line-delimited JSON, one message per line):
//   Request:   { "id": <string>, "method": <string>, "params": <object> }
//   Response:  { "id": <string>, "result": <any> }
//   Error:     { "id": <string>, "error": <string> }
//   Event:     { "event": <string>, "id"?: <string>, "data": <any> }
//
// Stdout = protocol channel only. All diagnostics go to stderr.

import { createInterface } from "node:readline";
import process from "node:process";

import * as claude from "./agents/claude.mjs";

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const log = (...args) => process.stderr.write("[sidecar] " + args.join(" ") + "\n");

const methods = {
  ping: async () => ({ pong: true, time: Date.now() }),
  claude_chat: async (params) => claude.chat(params),
  wizard_questions: async (params) => claude.wizardQuestions(params),
  build_structure: async (params) => claude.buildStructure(params),
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
  try {
    const result = await handler(params ?? {});
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

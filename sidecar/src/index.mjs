// Learn (Almost) Anything sidecar — JSON-RPC over stdio.
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
import * as devlog from "./lib/devlog.mjs";
import { probeMcp } from "./lib/mcp-probe.mjs";

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const log = (...args) => process.stderr.write("[sidecar] " + args.join(" ") + "\n");

const agents = { claude, codex };

function pickAgent(params) {
  const name = params?.backend ?? "claude";
  if (!agents[name]) throw new Error(`unknown backend: ${name}`);
  return agents[name];
}

// Best-effort human-readable course/section labels for the dev log. Params
// don't carry a courseId on the LLM stages, but topic + submodule title pin
// down which course and section a call belongs to.
function courseContext(params) {
  const course =
    params?.courseId || params?.topic || params?.course?.title || params?.course?.topic || "";
  const section = params?.submodulePath?.title || params?.modulePath?.title || "";
  return {
    course: String(course).slice(0, 100),
    section: String(section).slice(0, 100),
    backend: params?.backend ?? "claude",
    model: params?.modelConfig?.model || "",
  };
}

const methods = {
  ping: async () => ({ pong: true, time: Date.now() }),
  chat: async (params) => pickAgent(params).chat(params),
  wizard_next_question: async (params, ctx) => pickAgent(params).wizardNextQuestion(params, ctx),
  suggest_course_idea: async (params, ctx) => pickAgent(params).suggestCourseIdea(params, ctx),
  build_structure: async (params, ctx) => pickAgent(params).buildStructure(params, ctx),
  generate_tags: async (params, ctx) => pickAgent(params).generateTags(params, ctx),
  build_roadmap: async (params, ctx) => pickAgent(params).buildRoadmap(params, ctx),
  roadmap_node_quiz: async (params, ctx) => pickAgent(params).roadmapNodeQuiz(params, ctx),
  refine_roadmap: async (params, ctx) => pickAgent(params).refineRoadmap(params, ctx),
  discover_mcp: async (params, ctx) => pickAgent(params).discoverMcp(params, ctx),
  probe_mcp: async (params, ctx) => probeMcp(params, ctx),
  refine_structure: async (params, ctx) => pickAgent(params).refineStructure(params, ctx),
  generate_submodule: async (params) => pickAgent(params).generateSubmodule(params),
  submodule_draft: async (params, ctx) => pickAgent(params).submoduleDraft(params, ctx),
  submodule_review: async (params, ctx) => pickAgent(params).submoduleReview(params, ctx),
  submodule_annotate: async (params, ctx) => pickAgent(params).submoduleAnnotate(params, ctx),
  plan_illustrations: async (params, ctx) => pickAgent(params).planIllustrations(params, ctx),
  submodule_review_images: async (params, ctx) => pickAgent(params).reviewImages(params, ctx),
  search_image_candidates: async (params, ctx) => pickAgent(params).searchImageCandidates(params, ctx),
  generate_test: async (params, ctx) => pickAgent(params).generateTest(params, ctx),
  generate_flashcards: async (params, ctx) => pickAgent(params).generateFlashcards(params, ctx),
  generate_assignments: async (params, ctx) => pickAgent(params).generateAssignments(params, ctx),
  review_assignment: async (params, ctx) => pickAgent(params).reviewAssignment(params, ctx),
  list_models: async (params) => pickAgent(params).listModels(),
  generate_image: async (params, ctx) => pickAgent(params).generateImage(params, ctx),
  translate_strings: async (params) => pickAgent(params).translateStrings(params),
  translate_markdown: async (params) => pickAgent(params).translateMarkdown(params),
  translate_diagram: async (params) => pickAgent(params).translateDiagram(params),
  translate_interactive: async (params) => pickAgent(params).translateInteractive(params),
  translate_template_params: async (params, ctx) => pickAgent(params).translateTemplateParams(params, ctx),
  detect_image_text_language: async (params) => pickAgent(params).detectImageTextLanguage(params),
  course_assistant: async (params, ctx) => pickAgent(params).courseAssistant(params, ctx),
  grade_answer: async (params, ctx) => pickAgent(params).gradeAnswer(params, ctx),
  rewrite_leech_card: async (params, ctx) => pickAgent(params).rewriteLeechCard(params, ctx),
  extract_learner_profile: async (params, ctx) => pickAgent(params).extractLearnerProfile(params, ctx),
  generate_diagnostic: async (params, ctx) => pickAgent(params).generateDiagnostic(params, ctx),
  verify_facts: async (params, ctx) => pickAgent(params).verifyFacts(params, ctx),
  fix_widget: async (params, ctx) => pickAgent(params).fixWidget(params, ctx),
  extend_article: async (params, ctx) => pickAgent(params).extendArticle(params, ctx),
  edit_text: async (params, ctx) => pickAgent(params).editText(params, ctx),
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
    const meta = { method, ...courseContext(params) };
    const result =
      method === "ping"
        ? await handler(params ?? {}, ctx)
        : await devlog.runRequest(meta, () => handler(params ?? {}, ctx));
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

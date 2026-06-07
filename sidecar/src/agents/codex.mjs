// Codex SDK wrapper.
//
// The SDK shells out to the local `codex` CLI binary, which authenticates via
// `codex login` (ChatGPT subscription). When `apiKey` is not provided, the SDK
// uses whatever auth the local CLI has configured — same subscription pattern
// as the Claude side.

import { readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { Codex } from "@openai/codex-sdk";

import {
  repairPrompt,
  validateInteractive,
  renderWidgetPng,
  rendererAvailable,
} from "../lib/interactive.mjs";
import { braveStdioServer } from "../lib/brave.mjs";
import * as devlog from "../lib/devlog.mjs";
import { context7StdioServer, mediawikiStdioServer } from "../lib/reference-mcp.mjs";
import {
  categoryClassifyGuide,
  categoryPreferredSourcesBlock,
  categoryPedagogyBlock,
  normalizeCategory,
  CATEGORY_IDS,
} from "../lib/categories.mjs";

// Codex SDK takes config overrides via constructor; we make a fresh
// instance per call when Brave MCP is needed so the key isn't held in
// long-lived state. Without a key, falls back to a shared instance.
let defaultCodex = null;

function codexOptions(config) {
  const cliPath = process.env.LEARN_ANYTHING_CODEX_CLI;
  if (!cliPath) {
    throw new Error(
      "Codex CLI is not installed or not visible to the app. Install @openai/codex, run codex login, and restart the app."
    );
  }
  return config ? { codexPathOverride: cliPath, config } : { codexPathOverride: cliPath };
}

function getDefaultCodex() {
  defaultCodex ??= new Codex(codexOptions());
  return defaultCodex;
}

function makeCodex(braveApiKey, opts = {}) {
  const config = {};
  if (opts.referenceMcp !== false) {
    config.mcp_servers = {
      context7: context7StdioServer(),
      mediawiki: mediawikiStdioServer(),
    };
  }
  if (braveApiKey) {
    config.mcp_servers = {
      ...(config.mcp_servers || {}),
      brave: braveStdioServer(braveApiKey),
    };
  }
  if (opts.imageGenerationEnabled === false) {
    config.features = { image_generation: false };
  }
  if (Object.keys(config).length === 0) return getDefaultCodex();
  return new Codex(codexOptions(config));
}

function terminologyGuide(lang) {
  return `Use the terminology that practitioners in this field actually use in language "${lang}". Prefer established loan words and idiomatic terms over literal translations (e.g. for programming in Russian: "легаси-код", not "наследие-код"; "деплой" / "deploy", not "развёртывание"; "merge request", not "запрос на слияние"). The exact vocabulary depends on the domain — match the register of how professionals in this field actually speak and write.`;
}

function naturalLanguageGuide(lang) {
  return `Write in natural, human-sounding language in "${lang}". Avoid AI-like filler, generic motivational phrases, formulaic transitions, over-polished symmetry, and repeated sentence patterns. Prefer concrete wording, varied sentence length, and the tone of a knowledgeable human tutor writing for one learner.`;
}

function languageStyleGuide(lang) {
  return `${terminologyGuide(lang)}\n\n${naturalLanguageGuide(lang)}`;
}

function normalizeCourseFormat(value) {
  return ["academic_course", "mini_module", "podcast_series"].includes(value)
    ? value
    : "academic_course";
}

function courseFormatGuide(courseFormat, lang) {
  const format = normalizeCourseFormat(courseFormat);
  if (format === "mini_module") {
    return `Generation format: mini-course for one module.
- Do not ask whether the learner wants a full course, mini-course, or podcast series; this has already been chosen.
- Keep the scope narrow and immediately useful.
- Structure: exactly 1 top-level module with 3-6 submodules.
- Materials should be concise and practical; avoid broad textbook coverage.
- Assessments should be small checks or exercises that fit a short intensive.`;
  }
  if (format === "podcast_series") {
    return `Generation format: podcast series.
- Do not ask whether the learner wants a full course, mini-course, or podcast series; this has already been chosen.
- Structure the curriculum as seasons/blocks and episodes: 3-6 top-level modules, each with 2-5 episode-like submodules.
- Submodule titles should feel like podcast episode titles while staying clear and educational.
- Materials should be written as listenable episode scripts: spoken explanations, narrative flow, examples, recap, and suggested listening notes.
- Do not generate tests or homework assignments for podcast-series material.
- Do not plan image/gallery/diagram/interactive widgets. If references help, mention them as optional show notes or source links, not visual lesson blocks.`;
  }
  return `Generation format: full academic course.
- Do not ask whether the learner wants a full course, mini-course, or podcast series; this has already been chosen.
- Build a serious, progressive curriculum with research-backed sequencing.
- Structure: 4-10 top-level modules, each with 2-6 submodules.
- Balance theory, examples, practice, tests, and assignments.
- Materials may be substantial lesson articles, but should still match the learner's goals and constraints.`;
}

function wizardQuestionGuide(courseFormat, lang) {
  const format = normalizeCourseFormat(courseFormat);
  if (format === "podcast_series") {
    return `For the podcast-series wizard, ask questions that shape the listening experience: episode length, tone, narrative style, depth, pacing, examples, host style, and whether the learner wants brief show notes or source links. Do NOT ask about maps, images, diagrams, galleries, drawing materials, visual assets, tests, or homework.`;
  }
  if (format === "mini_module") {
    return `For the mini-course wizard, ask only questions that materially narrow one compact module: outcome, current level, time budget, and the few subtopics that matter most.`;
  }
  return "";
}

function podcastNoWidgetGuide(courseFormat) {
  if (normalizeCourseFormat(courseFormat) !== "podcast_series") return "";
  return `PODCAST FORMAT OVERRIDE:
- Do not insert any ::widget markers.
- Return empty arrays for imageWidgets, galleryWidgets, diagramWidgets, videoWidgets, and interactiveWidgets.
- If a map, image, chart, or diagram would normally help, describe it verbally or put a source link in "sources"/show notes instead of making a visual widget.`;
}

function normalizeCourseTitle(value) {
  if (typeof value !== "string") return "";
  return value
    .trim()
    .replace(/^["'«“”]+|["'»“”]+$/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 80)
    .trim();
}

const baseThreadOptions = {
  // We're not in a git repo at the user's course-data dir, and we don't want
  // codex to refuse to run for that reason.
  skipGitRepoCheck: true,
  // No filesystem mutation during these turns.
  sandboxMode: "read-only",
  // Internet by default for every stage (draft, structure, refine, …) — applied
  // to all calls via threadOptions(). Keep both enabled; the content quality
  // depends on the agent being able to verify facts online.
  networkAccessEnabled: true,
  webSearchEnabled: true,
};

// Maps a { model, reasoning } config (from settings) onto Codex ThreadOptions.
// Some Codex models do not support "minimal"; use "low" for off-like settings.
// Claude-only "max" → "high".
function modelThreadOptions(modelConfig) {
  const out = {};
  const model = modelConfig?.model;
  if (typeof model === "string" && model.trim()) out.model = model.trim();
  const reasoning = modelConfig?.reasoning;
  if (typeof reasoning === "string" && reasoning.trim()) {
    const map = {
      off: "low",
      none: "low",
      disabled: "low",
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "high",
    };
    const eff = map[reasoning.trim().toLowerCase()];
    if (eff) out.modelReasoningEffort = eff;
  }
  return out;
}

function threadOptions(opts) {
  const overrides = {};
  if (typeof opts?.networkAccessEnabled === "boolean") {
    overrides.networkAccessEnabled = opts.networkAccessEnabled;
  }
  if (typeof opts?.webSearchEnabled === "boolean") {
    overrides.webSearchEnabled = opts.webSearchEnabled;
  }
  // Point Codex at a live space directory so its sandbox can explore it (read
  // code, list/grep files). Pin sandboxMode to read-only so the user's files
  // can never be modified, created, or deleted.
  const dirs = Array.isArray(opts?.dirs) ? opts.dirs.filter(Boolean) : [];
  if (dirs.length) {
    overrides.workingDirectory = dirs[0];
    overrides.sandboxMode = "read-only";
  }
  return { ...baseThreadOptions, ...overrides, ...modelThreadOptions(opts?.modelConfig) };
}

async function runOnce(prompt, outputSchema, opts) {
  const rec = devlog.startCall({ backend: "codex", prompt, model: opts?.modelConfig?.model });
  try {
    const thread = makeCodex(opts?.braveApiKey, opts).startThread(threadOptions(opts));
    const turn = await thread.run(prompt, outputSchema ? { outputSchema } : undefined);
    rec.end(turn.finalResponse);
    return turn.finalResponse;
  } catch (e) {
    rec.error(e);
    throw e;
  }
}

async function runStreamed(prompt, outputSchema, onProgress, opts) {
  if (!onProgress) return await runOnce(prompt, outputSchema, opts);
  const rec = devlog.startCall({ backend: "codex", prompt, model: opts?.modelConfig?.model });
  const idleTimeoutMs = opts?.idleTimeoutMs ?? 0;
  const totalTimeoutMs = opts?.totalTimeoutMs ?? 0;
  const thread = makeCodex(opts?.braveApiKey, opts).startThread(threadOptions(opts));
  const controller = new AbortController();
  let timeoutReason = "";
  let idleTimer = null;
  let totalTimer = null;
  const abortAfter = (ms, message) => {
    if (!ms) return null;
    const timer = setTimeout(() => {
      timeoutReason = message;
      controller.abort();
    }, ms);
    timer.unref?.();
    return timer;
  };
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = abortAfter(
      idleTimeoutMs,
      `Codex produced no progress for ${Math.round(idleTimeoutMs / 1000)} seconds`
    );
  };
  onProgress({ label: "running", detail: "Starting Codex" });
  resetIdleTimer();
  totalTimer = abortAfter(
    totalTimeoutMs,
    `Codex did not finish within ${Math.round(totalTimeoutMs / 1000)} seconds`
  );
  const stream = await thread.runStreamed(
    prompt,
    outputSchema ? { outputSchema, signal: controller.signal } : { signal: controller.signal }
  );
  let final = "";
  try {
    for await (const ev of stream.events) {
      resetIdleTimer();
      if (ev.type === "turn.started") {
        onProgress({ label: "thinking" });
      } else if (ev.type === "turn.failed") {
        throw new Error(ev.error?.message || "codex turn failed");
      } else if (ev.type === "item.started" || ev.type === "item.updated") {
        const item = ev.item;
        if (!item) continue;
        if (item.type === "web_search") {
          onProgress({ label: "searching", detail: item.query || "" });
        } else if (item.type === "reasoning") {
          // Reasoning text may be hidden by the CLI; still show that Codex is alive.
          const detail =
            typeof item.text === "string" && item.text.trim() ? item.text.trim() : undefined;
          onProgress({ label: "thinking", detail });
        } else if (
          item.type === "agent_message" &&
          typeof item.text === "string" &&
          item.text.trim()
        ) {
          // The final message is structured JSON for most stages — keep it a
          // short indicator rather than dumping the whole payload.
          const tail = item.text.replace(/\s+/g, " ").trim().slice(-80);
          onProgress({ label: "writing", detail: tail });
        } else if (item.type === "command_execution" && item.command) {
          onProgress({ label: "running", detail: String(item.command).slice(0, 100) });
        } else if (item.type === "mcp_tool_call") {
          onProgress({ label: "running", detail: `${item.server}.${item.tool}` });
        }
      } else if (ev.type === "item.completed") {
        const item = ev.item;
        if (item?.type === "agent_message" && typeof item.text === "string") {
          final = item.text;
        } else if (item?.type === "reasoning" && typeof item.text === "string" && item.text.trim()) {
          rec.reasoning(item.text);
        } else if (item?.type === "web_search") {
          rec.tool("web_search", item.query || "");
        } else if (item?.type === "command_execution" && item.command) {
          rec.tool("command", String(item.command).slice(0, 200));
        } else if (item?.type === "mcp_tool_call") {
          rec.tool("mcp", `${item.server}.${item.tool}`);
        }
      } else if (ev.type === "error") {
        throw new Error(ev.message || "codex stream error");
      }
    }
    if (!final.trim()) throw new Error("Codex response missing final message");
    rec.end(final);
    return final;
  } catch (e) {
    rec.error(e);
    if (timeoutReason) throw new Error(timeoutReason);
    throw e;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    if (totalTimer) clearTimeout(totalTimer);
  }
}

// The Codex CLI caches the live model catalog at ~/.codex/models_cache.json —
// read it for the real list + each model's real reasoning-effort levels.
export async function listModels() {
  try {
    const path = join(homedir(), ".codex", "models_cache.json");
    const cache = JSON.parse(readFileSync(path, "utf8"));
    const models = (cache.models || [])
      .filter((m) => m && m.slug && m.visibility === "list")
      .map((m) => ({
        value: m.slug,
        label: m.display_name || m.slug,
        description: m.description || "",
        effortLevels: (m.supported_reasoning_levels || [])
          .map((r) => r.effort)
          .filter(Boolean),
      }));
    if (models.length) return { models };
  } catch {
    /* fall through to the minimal fallback */
  }
  return {
    models: [
      {
        value: "gpt-5.1-codex",
        label: "GPT-5.1 Codex",
        description: "Coding model",
        effortLevels: ["low", "medium", "high", "xhigh"],
      },
    ],
  };
}

const GENERATED_IMAGES_DIR = join(homedir(), ".codex", "generated_images");

function listImages(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
function mtimeOf(p) {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Generate an illustration via Codex's $imagegen skill (gpt-image-2). Output
 * lands in ~/.codex/generated_images/ — we diff the dir to find the new file.
 * Best-effort: returns { path: null } if the skill didn't produce anything.
 * @param {{ prompt: string }} params
 * @returns {Promise<{ path: string|null }>}
 */
export async function generateImage({ prompt }, ctx) {
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new Error("prompt required for image generation");
  }
  const before = new Set(listImages(GENERATED_IMAGES_DIR));
  ctx?.progress?.({ label: "generating", detail: prompt.slice(0, 100) });
  const thread = getDefaultCodex().startThread({
    skipGitRepoCheck: true,
    sandboxMode: "workspace-write",
    networkAccessEnabled: true,
    webSearchEnabled: false,
  });
  const input = `Generate ONE high-quality educational illustration using the $imagegen skill. Produce only the image — no code, no explanation.\n\nIllustration: ${prompt}`;
  await thread.run(input);
  const fresh = listImages(GENERATED_IMAGES_DIR).filter(
    (f) => !before.has(f) && /\.(png|jpe?g|webp)$/i.test(f)
  );
  if (fresh.length === 0) return { path: null };
  fresh.sort(
    (a, b) => mtimeOf(join(GENERATED_IMAGES_DIR, b)) - mtimeOf(join(GENERATED_IMAGES_DIR, a))
  );
  return { path: join(GENERATED_IMAGES_DIR, fresh[0]) };
}

/**
 * @param {{ prompt: string }} params
 */
export async function chat({ prompt }) {
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new Error("prompt must be a non-empty string");
  }
  const text = await runOnce(prompt);
  return { text };
}

function normalizeWizardQuestion(q) {
  if (!q || typeof q.text !== "string") return null;
  const text = q.text.trim();
  if (!text) return null;
  const options = Array.isArray(q.options)
    ? q.options.filter((o) => typeof o === "string" && o.trim().length > 0).map((o) => o.trim())
    : [];
  const multi = q.multi !== false;
  return { text, options, multi };
}

function answeredBlock(answered) {
  if (!Array.isArray(answered) || answered.length === 0) {
    return "(none yet — this is the FIRST question)";
  }
  return answered
    .map((qa, i) => `${i + 1}. Q: ${qa?.question ?? ""}\n   A: ${qa?.answer ?? ""}`)
    .join("\n");
}

/**
 * Adaptive clarifying interview — returns the single most valuable NEXT question
 * (building on prior answers) or done=true once enough is gathered. 3-10 total.
 * @param {{ topic:string, language:string, courseFormat?:string, answered?:Array<{question:string,answer:string}> }} params
 * @returns {Promise<{title?:string, done:boolean, question?:{text:string,options:string[],multi:boolean}}>}
 */
export async function wizardNextQuestion(
  { topic, language, courseFormat, answered, modelConfig, spaceSources, spaceLinks, spaceDirs, spaceStrict },
  ctx
) {
  if (typeof topic !== "string" || !topic.trim()) {
    throw new Error("topic must be a non-empty string");
  }
  const lang = (language || "en").trim();
  const asked = Array.isArray(answered) ? answered : [];
  const isFirst = asked.length === 0;
  const hasSpace =
    (Array.isArray(spaceDirs) && spaceDirs.length > 0) ||
    (Array.isArray(spaceSources) && spaceSources.length > 0) ||
    (Array.isArray(spaceLinks) && spaceLinks.length > 0);
  const spaceProbe = hasSpace
    ? `\nThis course is built inside a SPACE with the attached material above (documents, links, and especially the attached DIRECTORIES/files). BEFORE choosing your question, INSPECT that material — open and skim the attached files/directories — and ground every clarifying question in what it actually contains and what is still ambiguous or missing for THIS material. Do not ask generic questions answerable from the material itself.\n`
    : "";
  const prompt = `You are running an ADAPTIVE clarifying interview with a learner
BEFORE building a personalized course on "${topic}" (language code "${lang}").

${courseFormatGuide(courseFormat, lang)}
${spaceContextBlock(spaceSources, spaceLinks, lang, spaceStrict, spaceDirs)}${spaceProbe}
Answers gathered so far:
${answeredBlock(asked)}

Decide the SINGLE most valuable NEXT question — the one whose answer would most
change how an excellent course for THIS specific person looks. It MUST build on
what they already told you: follow up on, drill into, disambiguate, or branch
from a previous answer. Never repeat covered ground, and never ask the learner
to choose the generation format again. Skip pleasantries.

Conduct between 3 and 10 questions in TOTAL. You have asked ${asked.length} so far.
- If you have asked FEWER than 3, you MUST ask another question (done=false).
- If you have asked AT LEAST 3 and now have enough to build an excellent,
  specific course, set done=true and set "question": null (and "title": null).
- Otherwise return the next "question".

When you ask a question, provide 3-5 realistic, mutually-distinct, concrete,
topic-specific answer options (short phrases in "${lang}", not generic
"low/medium/high"). The learner has a free-text fallback, so do NOT add an
"other" option. Set "multi": true by default (preferences, scope, materials,
goals usually accept several answers); set "multi": false ONLY when answers are
genuinely mutually exclusive (time per week, current level, work vs hobby).
${wizardQuestionGuide(courseFormat, lang)}
${isFirst ? `Also generate a short display "title": a concise noun phrase, 2-6 words in "${lang}", NOT copying the raw request, no quotes, no "course about/on" wrapper.\n` : ""}
Write everything in language "${lang}".

${languageStyleGuide(lang)}`;

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      title: { type: ["string", "null"] },
      done: { type: "boolean" },
      question: {
        type: ["object", "null"],
        additionalProperties: false,
        properties: {
          text: { type: "string" },
          options: { type: "array", items: { type: "string" } },
          multi: { type: "boolean" },
        },
        required: ["text", "options", "multi"],
      },
    },
    required: ["title", "done", "question"],
  };

  const text = await runStreamed(prompt, schema, ctx?.progress, {
    modelConfig,
    dirs: spaceDirs,
    idleTimeoutMs: 180_000,
    totalTimeoutMs: 900_000,
  });
  const parsed = JSON.parse(text);
  const question = parsed?.done === true ? null : normalizeWizardQuestion(parsed?.question);
  const out = { done: !question };
  if (question) out.question = question;
  if (isFirst) {
    const title = normalizeCourseTitle(parsed?.title);
    if (title) out.title = title;
  }
  return out;
}

export async function suggestCourseIdea({ courses, language, modelConfig }, ctx) {
  const lang = (language || "en").trim();
  const courseList = Array.isArray(courses) ? courses.slice(0, 50) : [];
  const prompt = `You are helping choose the next useful course for a learner.
The app already has these local courses:
${JSON.stringify(courseList, null, 2)}

Suggest exactly ONE NEW standalone course idea. It should be adjacent to,
deeper than, or usefully complementary to the existing courses, but it must be
a separate course topic, not a continuation of an existing course.

Hard rules:
- Do not duplicate or lightly rename any existing course topic/title.
- Do not suggest the next lesson, module, submodule, unit, homework, or visit
  inside an existing course.
- Do not use action wording like "continue", "resume", "lesson 1", "unit 2",
  "next module", or "part 2".
- Do not return the current focus course with a narrower lesson title.
- The "topic" must be suitable as the raw topic for creating a brand-new course.
- If the list is empty, suggest a strong first course for a curious learner.
- Avoid generic productivity/self-help suggestions.

Keep this fast: do not research the web. Use only the course list above and
general judgment. Write the topic and title in language code "${lang}".

${languageStyleGuide(lang)}`;

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      topic: { type: "string" },
      title: { type: "string" },
      reason: { type: "string" },
    },
    required: ["topic", "title", "reason"],
  };

  ctx?.progress?.({ label: "thinking" });
  const text = await runStreamed(prompt, schema, ctx?.progress, {
    modelConfig,
    imageGenerationEnabled: false,
    webSearchEnabled: false,
  });
  const parsed = JSON.parse(text);
  const topic = normalizeCourseTitle(parsed?.topic);
  if (!topic) throw new Error("Codex response missing topic");
  return {
    topic,
    title: normalizeCourseTitle(parsed?.title) || topic,
    reason: typeof parsed?.reason === "string" ? parsed.reason.trim().slice(0, 240) : "",
  };
}

function prevArticlesBlock(previousArticles, lang) {
  if (!previousArticles || previousArticles.length === 0) return "";
  const formatted = previousArticles
    .map((p) => `### ${p.moduleTitle} / ${p.submoduleTitle}\n${p.article}`)
    .join("\n\n---\n\n");
  return `Previously written submodules — read them for context and continuity.
Refer back when natural, do NOT contradict anything in them, do NOT repeat
their content verbatim. Write in language "${lang}" the same as them.

<previous-articles>
${formatted}
</previous-articles>

`;
}

const testSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string" },
          options: { type: "array", items: { type: "string" } },
          correct: { type: "integer" },
          explanation: { type: "string" },
          concept: { type: "string" },
        },
        required: ["text", "options", "correct", "explanation", "concept"],
      },
    },
  },
  required: ["questions"],
};

/**
 * @param {{topic:string, language:string, submodulePath:{title:string,summary:string}, article:string, braveApiKey?:string}} params
 */
export async function translateStrings({ sourceLang, targetLang, strings, modelConfig }) {
  const arr = Array.isArray(strings) ? strings : [];
  if (!arr.length) return { translations: [] };
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: { translations: { type: "array", items: { type: "string" } } },
    required: ["translations"],
  };
  const prompt = `Translate each element of this JSON array of strings from language "${sourceLang || "auto"}" into language "${targetLang}".
- Keep meaning and tone; use idiomatic, professional target-language terminology.
- Do NOT translate code, identifiers, file paths, URLs, numbers, or {placeholders} — keep them verbatim.
- Preserve order and array length exactly: translations[i] is the translation of input[i].
Return { "translations": [...] }.

${JSON.stringify(arr)}`;
  const text = await runOnce(prompt, schema, { modelConfig });
  let parsed = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    /* leave empty */
  }
  const out = Array.isArray(parsed?.translations) ? parsed.translations : [];
  return { translations: out.map((x) => String(x ?? "")) };
}

export async function translateMarkdown({ sourceLang, targetLang, markdown, modelConfig }) {
  if (typeof markdown !== "string" || !markdown.trim()) return { markdown: markdown || "" };
  const prompt = `Translate the following Markdown lesson from language "${sourceLang || "auto"}" into language "${targetLang}". Rules:
- Translate ALL prose and headings into ${targetLang} with natural, professional wording.
- Keep the Markdown structure identical (headings, lists, tables, blockquotes, emphasis).
- Do NOT translate or alter fenced code blocks or inline code — keep code verbatim; you MAY translate code COMMENTS into ${targetLang}.
- Keep LaTeX/math ($...$, $$...$$) intact.
- Keep every ::widget{...} marker line EXACTLY as-is.
- Keep URLs, identifiers, numbers and {placeholders} unchanged.
Return ONLY the translated Markdown, nothing else.

${markdown}`;
  const text = await runOnce(prompt, undefined, { modelConfig });
  return { markdown: (text || "").trim() || markdown };
}

// Translate the human-readable labels inside a Mermaid diagram, preserving all
// syntax, node IDs, keywords, directions and arrows so it still renders.
export async function translateDiagram({ sourceLang, targetLang, source, modelConfig }) {
  if (typeof source !== "string" || !source.trim()) return { source: source || "" };
  const prompt = `Translate the human-readable labels in this Mermaid diagram from "${sourceLang || "auto"}" into "${targetLang}". Rules:
- Translate ONLY visible label text: words inside [ ], ( ), { }, (( )), [[ ]], >] shapes, quoted "..." labels, and the message text after ':' in sequence/class diagrams.
- Do NOT change anything else: the diagram-type keyword (flowchart, sequenceDiagram, classDiagram, stateDiagram, erDiagram, gantt, pie, mindmap, ...), directions (LR/TD/TB/RL/BT), node IDs, arrows and links (-->, ---, -.->, ==>, ->>, --x, etc.), %% comments, %%{ ... }%% directives, class/style lines, and all punctuation/syntax.
- Keep node IDs identical so edges still connect, and keep the line structure.
Return ONLY the Mermaid source — no code fences, no commentary.

${source}`;
  const text = await runOnce(prompt, undefined, { modelConfig });
  return { source: (text || "").trim() || source };
}

// Localize the visible UI text of an interactive widget (HTML/CSS/JS), keeping
// all code, markup structure, identifiers and logic intact.
export async function translateInteractive({ sourceLang, targetLang, html, css, js, modelConfig }) {
  const prompt = `Localize a tiny self-contained web widget from "${sourceLang || "auto"}" into "${targetLang}". You get its HTML body, CSS and JS.
Translate ONLY human-visible UI text into ${targetLang}:
- visible text nodes in the HTML; button/label/option text; the VALUES of placeholder, title, aria-label and alt attributes; and string literals in the JS that are shown to the user (labels, on-screen messages).
Do NOT translate or modify anything else: tag names, attribute NAMES, element ids/classes, data-* keys, CSS (selectors, properties, values), JS code, variable/function/property names, object keys, URLs, numbers, or any logic or structure. Preserve everything except the translated visible text.
Return ONLY a single-line JSON object: {"html":"...","css":"...","js":"..."}.

<html>
${html || ""}
</html>
<css>
${css || ""}
</css>
<js>
${js || ""}
</js>`;
  const text = await runOnce(prompt, undefined, { modelConfig });
  const parsed = extractJsonLoose(text);
  return {
    html: typeof parsed?.html === "string" ? parsed.html : html || "",
    css: typeof parsed?.css === "string" ? parsed.css : css || "",
    js: typeof parsed?.js === "string" ? parsed.js : js || "",
  };
}

// Render a compact context block for a widget the learner targeted ("✦ Ask").
function widgetContextBlock(widget) {
  const w = widget && typeof widget === "object" ? widget.widget : null;
  if (!w || typeof w !== "object") return "";
  const type = w.type || "widget";
  let detail;
  if (type === "diagram") {
    detail = `Mermaid source:\n${w.source || ""}${w.error ? `\n\nKnown render error: ${w.error}` : ""}`;
  } else if (type === "interactive") {
    detail = `Title: ${w.title || ""}\nDescription: ${w.description || ""}\nHTML:\n${w.html || ""}\nCSS:\n${w.css || ""}\nJS:\n${w.js || ""}${w.error ? `\n\nKnown error: ${w.error}` : ""}`;
  } else if (type === "image" || type === "gallery") {
    detail = `Description: ${w.description || w.alt || w.caption || ""}${w.source ? `\nSource page: ${w.source}` : ""}`;
  } else if (type === "video") {
    detail = `Title: ${w.title || ""}\nURL: ${w.url || ""}`;
  } else {
    detail = JSON.stringify(w).slice(0, 1000);
  }
  return `The learner is asking about THIS specific ${type} widget in the lesson (id ${widget.id || "?"}) — focus your answer on it:\n<widget>\n${detail}\n</widget>\n\n`;
}

export async function courseAssistant(
  {
    language,
    topic,
    structure,
    article,
    fragment,
    question,
    history,
    spaceSources,
    spaceLinks,
    spaceDirs,
    spaceStrict,
    imagePath,
    widget,
    modelConfig,
  },
  ctx
) {
  const lang = (language || "en").trim();
  const hist = Array.isArray(history) ? history.slice(-8) : [];
  const histBlock = hist.length
    ? `Conversation so far:\n${hist
        .map((m) => `${m.role === "assistant" ? "Assistant" : "Learner"}: ${m.text}`)
        .join("\n")}\n\n`
    : "";
  const fragBlock =
    fragment && String(fragment).trim()
      ? `The learner highlighted this fragment from the course material — focus your answer on it:\n<fragment>\n${fragment}\n</fragment>\n\n`
      : "";
  const widgetBlock = widgetContextBlock(widget);
  const articleBlock =
    article && String(article).trim()
      ? `The lesson the learner is currently reading:\n<lesson>\n${article}\n</lesson>\n\n`
      : "";
  const prompt = `You are a knowledgeable, friendly tutor for a learner taking a course on "${topic}". Answer the learner's question in language "${lang}".
Ground your answer in the COURSE PROGRAM and the lesson material below; prefer the course's own framing and terminology. If the question is outside the course's scope, say so briefly and still help where you can.
${spaceContextBlock(spaceSources, spaceLinks, lang, spaceStrict, spaceDirs)}
Course program (curriculum):
<structure>
${JSON.stringify(structure ?? {}, null, 2)}
</structure>

${articleBlock}${fragBlock}${widgetBlock}${histBlock}Learner's question: ${question}

Answer in ${lang}, in Markdown. Be concise but complete; use examples or code where they help.`;
  // Attached image → send it as a local_image input item so Codex can see it.
  const input =
    imagePath && String(imagePath).trim()
      ? [
          {
            type: "text",
            text: `${prompt}\n\nThe learner attached an image — examine it carefully and ground your answer in what it actually shows (e.g. judge whether something is drawn/done correctly).`,
          },
          { type: "local_image", path: imagePath },
        ]
      : prompt;
  const text = await runStreamed(input, undefined, ctx?.progress, {
    modelConfig,
    dirs: spaceDirs,
  });
  return { answer: (text || "").trim() };
}

// Vision text-language detection is done via Claude (the Rust side forces
// backend="claude"); this codex stub keeps the method present and safe.
export async function detectImageTextLanguage() {
  return { hasText: false, language: "", translate: false };
}

export async function generateTest({ topic, language, courseFormat, submodulePath, article, braveApiKey, modelConfig, category, genProfile, structure }, ctx) {
  if (typeof article !== "string" || !article.trim()) {
    throw new Error("article required for test generation");
  }
  const lang = (language || "en").trim();
  const isPodcast = normalizeCourseFormat(courseFormat) === "podcast_series";
  const recallGuide = isPodcast
    ? `\nThis is a PODCAST EPISODE — the text below is its transcript/script. Write RECALL questions about what was actually said and explained in the episode, so the listener can self-check and schedule spaced review.\n`
    : "";
  const intensity = genProfile?.pedagogyIntensity || "standard";
  const outline = Array.isArray(structure?.modules)
    ? structure.modules
        .map((m) => `- ${m.title}: ${(m.submodules || []).map((s) => s.title).join("; ")}`)
        .join("\n")
    : "";
  const interleaveGuide =
    intensity === "lean" || !outline
      ? ""
      : `\nINTERLEAVING: ALSO include 1-2 CUMULATIVE questions connecting THIS submodule to an EARLIER one in the outline below (mix in a prior concept). Tag their "concept" accordingly.\nCourse outline:\n${outline}\n`;
  const prompt = `You are writing a short comprehension test for a submodule of
a course on "${topic}" (language: ${lang}).

${courseFormatGuide(courseFormat, lang)}
${categoryPedagogyBlock(category, lang, intensity)}${recallGuide}
Submodule: ${submodulePath?.title || ""}${submodulePath?.summary ? ` — ${submodulePath.summary}` : ""}

${isPodcast ? "Episode transcript the test must be based on" : "Article the test must be based on"}:
<article>
${article}
</article>
${interleaveGuide}

Write a POOL of 10-16 multiple-choice questions that check real UNDERSTANDING
of this article — not trivia or verbatim recall. Only a random subset is shown
per attempt, so make them VARIED and non-overlapping (cover different points;
avoid near-duplicates). Each question has 3-5 plausible
options, exactly ONE correct ("correct" = 0-based index), a one-sentence
"explanation", and a "concept" (2-4 word tag naming the single concept/skill
it checks, used later for spaced review and weak-spot diagnosis). All in
language "${lang}".

${languageStyleGuide(lang)}`;
  ctx?.progress?.({ label: "thinking" });
  const text = await runStreamed(prompt, testSchema, ctx?.progress, { braveApiKey, modelConfig });
  const parsed = JSON.parse(text);
  return { questions: normalizeTestQuestions(parsed?.questions) };
}

function normalizeTestQuestions(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((q) => {
      if (!q || typeof q.text !== "string" || !q.text.trim()) return null;
      const options = Array.isArray(q.options)
        ? q.options.filter((o) => typeof o === "string" && o.trim()).map((o) => o.trim())
        : [];
      if (options.length < 2) return null;
      let correct = typeof q.correct === "number" ? Math.round(q.correct) : 0;
      if (correct < 0 || correct >= options.length) correct = 0;
      return {
        text: q.text.trim(),
        options,
        correct,
        explanation: typeof q.explanation === "string" ? q.explanation.trim() : "",
        concept: typeof q.concept === "string" ? q.concept.trim() : "",
      };
    })
    .filter(Boolean);
}

// ── Flashcards (active recall) ──────────────────────────────────────────────

const flashcardSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    flashcards: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          front: { type: "string" },
          back: { type: "string" },
        },
        required: ["front", "back"],
      },
    },
  },
  required: ["flashcards"],
};

function normalizeFlashcards(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((c) => {
      if (!c) return null;
      const front = typeof c.front === "string" ? c.front.trim() : "";
      const back = typeof c.back === "string" ? c.back.trim() : "";
      if (!front || !back) return null;
      return { front, back };
    })
    .filter(Boolean)
    .slice(0, 14);
}

export async function generateFlashcards(
  { topic, language, courseFormat, submodulePath, article, braveApiKey, modelConfig, category, genProfile },
  ctx
) {
  if (typeof article !== "string" || !article.trim()) {
    throw new Error("article required for flashcard generation");
  }
  const lang = (language || "en").trim();
  const intensity = genProfile?.pedagogyIntensity || "standard";
  const isPodcast = normalizeCourseFormat(courseFormat) === "podcast_series";
  const source = isPodcast ? "episode transcript" : "article";
  const prompt = `You are extracting active-recall FLASHCARDS for a submodule of a
course on "${topic}" (language: ${lang}).

${categoryPedagogyBlock(category, lang, intensity)}
Submodule: ${submodulePath?.title || ""}${submodulePath?.summary ? ` — ${submodulePath.summary}` : ""}

The ${source} the learner just studied:
<article>
${article}
</article>

Write 6-12 flashcards covering the load-bearing facts, definitions, and
relationships from this ${source}. Each card has a "front" (a single focused
prompt — a question, term, or cloze with one blank) and a concise "back"
(the answer, 1-2 sentences or a definition). Make them ATOMIC (one idea per
card), test RECALL not recognition, keep code/identifiers/numbers verbatim,
and write in language "${lang}".

${languageStyleGuide(lang)}`;
  ctx?.progress?.({ label: "thinking" });
  const text = await runStreamed(prompt, flashcardSchema, ctx?.progress, { braveApiKey, modelConfig });
  const parsed = JSON.parse(text);
  return { flashcards: normalizeFlashcards(parsed?.flashcards) };
}

// Minimal JSON extractor for Codex review (no schema — needs LLM image input
// which can't co-exist easily with strict outputSchema).
function extractJsonLoose(text) {
  const trimmed = (text || "").trim();
  try { return JSON.parse(trimmed); } catch {}
  const brace = trimmed.match(/\{[\s\S]*\}/);
  if (brace) {
    try { return JSON.parse(brace[0]); } catch {}
  }
  throw new Error("no JSON in response: " + trimmed.slice(0, 200));
}

// ── Homework assignments ────────────────────────────────────────────────────

const ASSIGNMENT_TYPES = ["image", "text", "document", "archive", "github"];
const CRITICALITIES = ["critical", "major", "minor"];

const assignmentSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    assignments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          prompt: { type: "string" },
          type: { type: "string", enum: ["image", "text", "document", "archive", "github"] },
          criteria: { type: "string" },
        },
        required: ["title", "prompt", "type", "criteria"],
      },
    },
  },
  required: ["assignments"],
};

function normalizeAssignments(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  raw.forEach((a, i) => {
    if (!a || typeof a.title !== "string" || !a.title.trim()) return;
    if (typeof a.prompt !== "string" || !a.prompt.trim()) return;
    let type = typeof a.type === "string" ? a.type.trim().toLowerCase() : "text";
    if (!ASSIGNMENT_TYPES.includes(type)) type = "text";
    out.push({
      id: `a${i + 1}`,
      title: a.title.trim(),
      prompt: a.prompt.trim(),
      type,
      criteria: typeof a.criteria === "string" ? a.criteria.trim() : "",
    });
  });
  return out.slice(0, 4);
}

function normalizeReview(parsed) {
  const remarks = Array.isArray(parsed?.remarks)
    ? parsed.remarks
        .filter((r) => r && typeof r.text === "string" && r.text.trim())
        .map((r) => ({
          text: r.text.trim(),
          criticality: CRITICALITIES.includes(String(r.criticality).toLowerCase())
            ? String(r.criticality).toLowerCase()
            : "minor",
        }))
    : [];
  let verdict = String(parsed?.verdict || "").toLowerCase();
  if (verdict !== "passed" && verdict !== "revise") verdict = "revise";
  if (remarks.some((r) => r.criticality === "critical" || r.criticality === "major")) {
    verdict = "revise";
  }
  return {
    remarks,
    verdict,
    summary: typeof parsed?.summary === "string" ? parsed.summary.trim() : "",
  };
}

/** Design a short chain of practical homework assignments for a submodule. */
export async function generateAssignments({ topic, language, courseFormat, submodulePath, article, braveApiKey, modelConfig, category, genProfile }, ctx) {
  if (normalizeCourseFormat(courseFormat) === "podcast_series") {
    return { assignments: [] };
  }
  if (typeof article !== "string" || !article.trim()) {
    throw new Error("article required for assignment generation");
  }
  const lang = (language || "en").trim();
  const intensity = genProfile?.pedagogyIntensity || "standard";
  const fadingGuide =
    intensity === "max"
      ? `\nSCAFFOLDING (worked -> guided -> independent): make the chain a faded progression — a WORKED example to complete, then a GUIDED task with hints, then an INDEPENDENT task with none.\n`
      : "";
  const prompt = `You are designing practical homework for one submodule of a
course on "${topic}" (language: ${lang}).

${courseFormatGuide(courseFormat, lang)}
${categoryPedagogyBlock(category, lang, intensity)}
Submodule: ${submodulePath?.title || ""}${submodulePath?.summary ? ` — ${submodulePath.summary}` : ""}

The article the learner just studied:
<article>
${article}
</article>
${fadingGuide}

Design a SHORT CHAIN of 1-3 practical assignments that make the learner APPLY
what they learned, ordered as a progression. For each pick the single best
submission type: "image" (drawing/sketch/diagram/photo), "text" (written
answer/essay), "document" (uploaded file), "archive" (.zip of a program),
"github" (link to a repo). Match type to skill: drawing→image,
writing→text, coding→archive/github, longer deliverables→document.
For each write clear "criteria" — concrete checkable things a reviewer grades
against (drives an iterative review-and-revise loop). Concrete, achievable from
the article; no busywork. All text in language "${lang}".

${languageStyleGuide(lang)}`;
  ctx?.progress?.({ label: "thinking" });
  const text = await runStreamed(prompt, assignmentSchema, ctx?.progress, { braveApiKey, modelConfig });
  const parsed = JSON.parse(text);
  return { assignments: normalizeAssignments(parsed?.assignments) };
}

/** Review one homework submission (vision + web aware) against its assignment. */
export async function reviewAssignment(params, ctx) {
  const { topic, language, assignment, submission, history, braveApiKey, modelConfig } = params;
  const lang = (language || "en").trim();
  const a = assignment || {};
  const sub = submission || {};
  const images = Array.isArray(sub.images) ? sub.images.filter((im) => im && im.path) : [];

  const histBlock =
    Array.isArray(history) && history.length
      ? `Conversation so far on this assignment (most recent last):\n${history
          .map((h) => `${h.role === "agent" ? "Reviewer" : "Learner"}: ${h.text}`)
          .join("\n")}\n\n`
      : "";
  const githubBlock = sub.githubUrl
    ? `\nThe learner submitted a GitHub repository: ${sub.githubUrl}\nInspect its README and key files (you have web access) before judging.\n`
    : "";
  const textBlock =
    typeof sub.text === "string" && sub.text.trim()
      ? `\nThe learner's submission (text / extracted file content):\n<submission>\n${sub.text.slice(0, 24000)}\n</submission>\n`
      : "";
  const imageNote = images.length
    ? `\nThe submission includes ${images.length} image(s) below — examine them visually.\n`
    : "";

  const promptText = `You are a strict but encouraging reviewer grading one homework assignment in a course on "${topic}". Respond in language "${lang}".

Assignment: ${a.title || ""}
Task: ${a.prompt || ""}
${a.criteria ? `Grading criteria:\n${a.criteria}\n` : ""}
${histBlock}Now review the learner's NEW submission below.${imageNote}${githubBlock}${textBlock}

Judge the submission against the task and criteria. Produce:
- "remarks": specific, actionable points. Each has "text" and "criticality" ∈
  "critical" | "major" | "minor". critical/major mean it does not yet meet the
  assignment.
- "verdict": "passed" ONLY if there are no critical or major remarks AND the work
  genuinely satisfies the assignment; otherwise "revise".
- "summary": 1-3 sentences on what to fix next (or congratulations if passed).
Reference what you actually see; don't pass weak work, don't nitpick endlessly.

${naturalLanguageGuide(lang)}

Output ONLY a single-line JSON object:
{"remarks":[{"text":"...","criticality":"major"}],"verdict":"revise","summary":"..."}`;

  const input = [{ type: "text", text: promptText }];
  for (const im of images) input.push({ type: "local_image", path: im.path });

  ctx?.progress?.({ label: "reviewing" });
  const thread = makeCodex(braveApiKey).startThread(threadOptions({ braveApiKey, modelConfig }));
  const turn = await thread.run(input);
  return normalizeReview(extractJsonLoose(turn.finalResponse));
}

/**
 * Vision review of candidate images for one image-widget slot.
 * @param {{language:string, description:string, alt:string, topic:string, candidates:{path:string}[], braveApiKey?:string}} params
 * @returns {Promise<{pick: number|null, reason: string, refinedQuery: string}>}
 */
export async function reviewImages(params, ctx) {
  const { language, description, alt, topic, candidates, braveApiKey, modelConfig } = params;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { pick: null, reason: "no candidates", refinedQuery: "" };
  }
  const lang = (language || "en").trim();
  const promptText = `You are reviewing candidate images for a course article
on "${topic}". The slot needs an image matching this description (in ${lang}):

  "${description}"
${alt ? `  alt text: "${alt}"\n` : ""}
Look at the ${candidates.length} numbered candidate image(s) below. Decide:
- If ONE of them clearly fits the slot, set "pick" to its index (0-based)
  and explain briefly why.
- If NONE fit well, set "pick" to null, explain in "reason" what's wrong
  (off-topic, low quality, watermarked, wrong style, etc.) and provide a
  refined search query in "refinedQuery" — English, more specific than
  the original description, suitable for an image search engine.

Output ONLY a single-line JSON object:
{"pick":<integer|null>,"reason":"<one or two sentences in ${lang}>","refinedQuery":"<english query or empty>"}`;

  const input = [{ type: "text", text: promptText }];
  for (let i = 0; i < candidates.length; i++) {
    input.push({ type: "text", text: `Candidate ${i}:` });
    input.push({ type: "local_image", path: candidates[i].path });
  }

  ctx?.progress?.({ label: "reviewing" });
  const thread = makeCodex(braveApiKey).startThread(threadOptions({ braveApiKey, modelConfig }));
  const turn = await thread.run(input);
  const parsed = extractJsonLoose(turn.finalResponse);
  return {
    pick: typeof parsed.pick === "number" ? parsed.pick : null,
    reason: typeof parsed.reason === "string" ? parsed.reason : "",
    refinedQuery: typeof parsed.refinedQuery === "string" ? parsed.refinedQuery : "",
  };
}

const imageCandidateSearchSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    candidates: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          source: { type: "string" },
          url: { type: "string" },
          reason: { type: "string" },
        },
        required: ["title", "source", "url", "reason"],
      },
    },
    refinedQuery: { type: "string" },
  },
  required: ["candidates", "refinedQuery"],
};

/**
 * Search the public web for image candidates when Brave image search is not
 * configured. The Rust layer will fetch source pages and extract og:image,
 * srcset, JSON-LD, and large img assets; this stage finds credible pages.
 * @param {{language:string, description:string, alt?:string, topic:string, query:string, modelConfig?:object}} params
 * @returns {Promise<{candidates:{title:string,source:string,url:string,reason:string}[], refinedQuery:string}>}
 */
export async function searchImageCandidates(params, ctx) {
  const { language, description, alt, topic, query: searchQuery, modelConfig } = params;
  const lang = (language || "en").trim();
  const prompt = `Find public image candidates for a course article on "${topic}".

The image slot needs, in language "${lang}":
  description: "${description}"
${alt ? `  alt text: "${alt}"\n` : ""}
Current search query: "${searchQuery || description}"

Use built-in web search and, when useful, fetch/read public source pages. Return
pages likely to contain the real image; the app can extract og:image,
twitter:image, srcset, JSON-LD ImageObject, and large <img> assets from them.

Rules:
- Search only public pages. Do not use login-only, paywalled, private, or DRM
  sources.
- Prefer museum/official collection pages, Wikimedia/Wikipedia file pages,
  archives, official documentation, and reputable publications.
- For famous artworks, real people, real places, museum halls, maps/plans,
  historical artifacts, technical diagrams, and software screenshots: find the
  real source. Never invent or suggest generated substitutes.
- For software screenshots, prefer official docs/product pages. Do not return
  pseudo-screenshots.
- It is OK if "url" is empty. Put a direct image URL there only when you are
  confident it is a real image file/asset. Always put the public page in
  "source" when available.
- Return 0-8 candidates. If nothing credible is found, return [] and provide a
  better refinedQuery.`;

  ctx?.progress?.({ label: "searching images", detail: searchQuery || description });
  const text = await runStreamed(
    prompt,
    imageCandidateSearchSchema,
    ctx?.progress,
    { modelConfig }
  );
  const parsed = JSON.parse(text);
  const candidates = Array.isArray(parsed?.candidates)
    ? parsed.candidates
        .filter((c) => c && (typeof c.source === "string" || typeof c.url === "string"))
        .slice(0, 8)
        .map((c) => ({
          title: String(c.title || "").slice(0, 200),
          source: String(c.source || ""),
          url: String(c.url || ""),
          reason: String(c.reason || "").slice(0, 400),
        }))
    : [];
  return {
    candidates,
    refinedQuery: typeof parsed?.refinedQuery === "string" ? parsed.refinedQuery : "",
  };
}

/** Stage 1 — draft a fresh article + initial widgets (images + diagrams). */
export async function submoduleDraft(params, ctx) {
  return await draftArticleInternal(params, ctx?.progress);
}

const draftSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    article: { type: "string" },
    notes: { type: "string" },
    imageWidgets: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          mode: { type: "string", enum: ["search", "generate"] },
          description: { type: "string" },
          prompt: { type: "string" },
          alt: { type: "string" },
          url: { type: "string" },
          source: { type: "string" },
        },
        required: ["id", "mode", "description", "prompt", "alt", "url", "source"],
      },
    },
    galleryWidgets: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          caption: { type: "string" },
          items: {
            type: "array",
            minItems: 2,
            maxItems: 6,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                mode: { type: "string", enum: ["search", "generate"] },
                description: { type: "string" },
                prompt: { type: "string" },
                alt: { type: "string" },
                url: { type: "string" },
                source: { type: "string" },
              },
              required: ["mode", "description", "prompt", "alt", "url", "source"],
            },
          },
        },
        required: ["id", "caption", "items"],
      },
    },
    diagramWidgets: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          source: { type: "string" },
          caption: { type: "string" },
        },
        required: ["id", "source", "caption"],
      },
    },
    videoWidgets: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          url: { type: "string" },
          title: { type: "string" },
          recommended_by: { type: "string" },
          why: { type: "string" },
        },
        required: ["id", "url", "title", "recommended_by", "why"],
      },
    },
    interactiveWidgets: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          html: { type: "string" },
          css: { type: "string" },
          js: { type: "string" },
          height: { type: "integer" },
        },
        required: ["id", "title", "description", "html", "css", "js", "height"],
      },
    },
    sources: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          url: { type: "string" },
        },
        required: ["title", "url"],
      },
    },
  },
  required: [
    "article",
    "notes",
    "imageWidgets",
    "galleryWidgets",
    "diagramWidgets",
    "videoWidgets",
    "interactiveWidgets",
    "sources",
  ],
};

// Renders the grounding block for a course scoped to a Space: curated reference
// documents + allowed sites/repos. Empty string when the course has no space.
function spaceContextBlock(spaceSources, spaceLinks, lang, strict = true, spaceDirs = []) {
  const docs = Array.isArray(spaceSources) ? spaceSources : [];
  const links = Array.isArray(spaceLinks) ? spaceLinks : [];
  const dirs = Array.isArray(spaceDirs) ? spaceDirs : [];
  if (!docs.length && !links.length && !dirs.length) return "";
  let out = strict
    ? `\n=== SCOPED COURSE — STRICT SOURCE RULE ===
This course is built inside a SPACE: a closed knowledge base. The ONLY permitted source of information for this course is the material listed below — the attached documents and the explicitly allowed sites/repositories. Hard rules:
- Use ONLY this material. Do NOT use your own background knowledge, do NOT invent facts, examples, names, numbers, dates or sources, and do NOT do general web research.
- This OVERRIDES any instruction elsewhere in this prompt to research how the subject is taught, to web-search, or to consult universities, Context7, Wikipedia/MediaWiki, etc. Those do NOT apply here.
- Build the curriculum and write every lesson EXCLUSIVELY from what this material actually contains. Cover what the sources cover, at the depth they cover it — no more.
- If the brief asks for something the sources do not address, omit it or note it is out of scope. Never fill the gap from outside.
- Write in language "${lang}".\n`
    : `\n=== SCOPED COURSE — PRIMARY SOURCES ===
This course is built inside a SPACE. Form the BASE of the course from the material listed below — it is the primary, authoritative source and the backbone of the curriculum and the lessons. You MAY supplement it with your own knowledge and targeted research to fill gaps, add depth, or clarify — but the space material must stay the foundation, the structure should follow it, and you must never contradict it. Write in language "${lang}".\n`;
  if (links.length) {
    out += strict
      ? `\nAllowed external sources — you MAY fetch/read these, and ONLY these (no other URLs or searches):\n`
      : `\nPreferred sources — start from these and favor them over the open web:\n`;
    out += links.map((l) => `- [${l.kind}] ${l.title}: ${l.url}`).join("\n") + "\n";
  }
  if (dirs.length) {
    out += `\nLocal directories you can READ and explore with your file tools (list, open, grep) — live source material such as a codebase. Read what you need to ground the course in the ACTUAL files; do not invent file contents:\n`;
    out += dirs.map((d) => `- ${d}`).join("\n") + "\n";
  }
  if (docs.length) {
    out += `\nSource documents (the authoritative material for this course):\n`;
    out += docs
      .map(
        (d, i) =>
          `\n<source ${i + 1} title="${String(d.title || "").replace(/"/g, "'")}" kind="${d.kind || "document"}">\n${d.content || ""}\n</source>`
      )
      .join("\n");
    out += "\n";
  }
  return out + "\n";
}

async function draftArticleInternal(
  {
    topic,
    language,
    courseFormat,
    courseMd,
    structure,
    memoryFiles,
    modulePath,
    submodulePath,
    previousArticles,
    braveApiKey,
    modelConfig,
    spaceSources,
    spaceLinks,
    spaceDirs,
    spaceStrict,
    category,
  },
  onProgress
) {
  const lang = (language || "en").trim();
  // Recommended sources for the course's category — but never when a strict
  // space is in force (that course may use ONLY its space material).
  const hasSpaceMaterial =
    (Array.isArray(spaceSources) && spaceSources.length) ||
    (Array.isArray(spaceLinks) && spaceLinks.length) ||
    (Array.isArray(spaceDirs) && spaceDirs.length);
  const categoryBlock =
    spaceStrict && hasSpaceMaterial ? "" : categoryPreferredSourcesBlock(category, lang);
  const pedagogyBlock = categoryPedagogyBlock(category, lang, "standard");
  const memoryBlock =
    memoryFiles && memoryFiles.length
      ? `Past user feedback (apply to tone and content):\n${memoryFiles
          .map((f) => `--- ${f.filename} ---\n${f.content}`)
          .join("\n\n")}\n\n`
      : "";
  const prompt = `You are writing one submodule of a personalized course on
"${topic}" (language: ${lang}).

${courseFormatGuide(courseFormat, lang)}
${podcastNoWidgetGuide(courseFormat)}

Course brief (wizard Q&A):
<course-md>
${courseMd}
</course-md>

Full curriculum (for context — do not repeat other modules):
<structure>
${JSON.stringify(structure, null, 2)}
</structure>

${spaceContextBlock(spaceSources, spaceLinks, lang, spaceStrict, spaceDirs)}${categoryBlock}${pedagogyBlock}${memoryBlock}${prevArticlesBlock(previousArticles, lang)}You are writing this specific submodule:
- Parent module: ${modulePath.title}${modulePath.summary ? ` — ${modulePath.summary}` : ""}
- This submodule: ${submodulePath.title}${submodulePath.summary ? ` — ${submodulePath.summary}` : ""}

Write the lesson material in language "${lang}". For a full academic course,
write a detailed, engaging article of ~600-1200 words. For a mini-course, keep
it compact and action-oriented. For a podcast series, write a listenable
episode script with spoken transitions, examples, recap, and listener notes.
Use Markdown headings (## / ###), short paragraphs, and concrete examples
specific to this learner (not generic textbook prose). Do not repeat the
overall course intro — assume the learner has the curriculum in front of them.
When relevant, reference what was established in earlier submodules to build
continuity. Never contradict them.

For non-podcast formats, you may add visual-aid widgets where they meaningfully help. Be friendly to
illustration count: on visual subjects, prefer several useful visuals over one
token image.

For abstract software / programming concepts — code patterns and refactors,
comparing two functions or approaches (e.g. duplicate functions like fetchUser
vs getUserById), architecture or decision trade-offs, code smells, edge cases,
before/after — and for AI / LLM material — prompts, system prompts, context
windows, tool/function schemas, JSON or config payloads, command output, logs,
or any other text/code artifact — AND for SOFTWARE UI of any kind: app /
program / editor / IDE windows, inspector or properties panels, dashboards,
settings screens, menus, toolbars/palettes, or app/website screenshots — do NOT
use image or gallery widgets: a searched or generated picture of these is
meaningless, hallucinated, or almost never findable, so it ends up an empty
placeholder. Instead, write a concrete, self-authored example INLINE as a real
Markdown fenced code block, or describe the interface in prose (which panel,
which fields). Reserve image/gallery widgets for genuinely visual subjects
(real photographs, real diagrams/charts of real data, maps, artworks, physical
objects, places) — never for software UI or screenshots.

Mark insertion
points with a single line, alone, with blank lines above and below:

  ::widget{type="image" id="img-1"}        (real-world photo or illustration)
  ::widget{type="gallery" id="gal-1"}      (2-6 related images shown together)
  ::widget{type="diagram" id="diag-1"}     (a Mermaid-rendered diagram)
  ::widget{type="video" id="vid-1"}        (an embedded video — see below)
  ::widget{type="interactive" id="int-1"}  (a tiny self-contained mini-app — see below)

Use 1-6 widgets total when the topic has concrete visual references, counting
one gallery as one widget. Use 0 only when the topic is purely textual prose.
Do a silent paragraph-by-paragraph visual pass:
for each paragraph, decide whether an image, gallery, diagram, video, or
interactive widget would make the learner understand faster. Add visuals where
they are genuinely useful; don't decorate every paragraph.
Diagrams are great for processes, hierarchies, state machines, sequences,
component relations. Use Mermaid syntax (flowchart TD, sequenceDiagram, etc.).

VIDEO WIDGETS: for non-podcast formats, actively look for 0-2 helpful YouTube
or Vimeo videos when a submodule would benefit from seeing a lecture, demo,
walkthrough, lab, performance, interview, or worked example. Prefer YouTube.
Do not pick a video purely by search rank or title. Use at least one quality
signal: an official channel/playlist, university/course syllabus, reputable
creator, blog/listicle recommendation, forum/Reddit recommendation, or the
video's surrounding page proving it is directly relevant. Put that evidence URL
in "recommended_by" (it may be the official video/channel/playlist page when
that is the evidence). If the video is not embeddable or you cannot find any
quality signal, skip it.

INTERACTIVE WIDGETS: small self-contained HTML+CSS+JS that runs in a
sandboxed iframe (no network, no cookies, no parent access). Use 0-2 per
submodule, only when interactivity meaningfully aids comprehension —
e.g. algorithm step-through (sorting, search), fill-in-the-blank with
check-answer, multiple-choice flashcard, slider that animates a value,
drag-to-match.

Hard rules — your widget WILL BE REJECTED if it breaks any of these:
  • Vanilla JS only. No frameworks, no <script src=…>, no imports, no eval,
    no new Function, no fetch, no XMLHttpRequest.
  • No localStorage/sessionStorage/cookies, no window.parent / window.top.
  • Total html + css + js ≤ 8000 characters.
  • All assets inline. Use DOM, addEventListener, requestAnimationFrame,
    setTimeout, Math.
  • Adapt to dark mode via @media (prefers-color-scheme: dark) in your CSS.

IMAGE AND GALLERY WIDGETS — set "mode" per image item:
  • "search" — a real, specific, existing thing to FIND not invent: a particular
    named artwork by a known artist, a real person/place/object/event, a
    historical artifact, a museum hall, a map, a real diagram/plan, or a real
    software screenshot. "prompt" = a precise search target.
  • "generate" — a custom conceptual/explanatory illustration that probably
    will not exist as a findable photo: an ideal artist workspace, what should
    be on a table, a staged practice setup, a stylized scene, an abstract
    concept made visual, or a detailed composition you describe.

For every image item, keep two fields separate:
  • "description" — a short learner-facing caption/description, 1 sentence,
    not a search prompt and not an accessibility alt dump.
  • "prompt" — the internal search target or generation prompt. For "search",
    make it precise enough to find the real image. For "generate", include
    subject, style, composition, lighting, and important objects.

Hard visual sourcing rules:
  • NEVER generate a screenshot of ANY kind — app/program UI, website or web page,
    terminal/console, dashboard, mobile screen, code editor, settings panel, error
    dialog, or any on-screen interface. Screenshots may ONLY come from "search" for
    a real one. If a real screenshot cannot be confidently found, SKIP the image
    (or describe it in text / use a Mermaid diagram). Under no circumstances set
    mode "generate" for a screenshot.
  • Famous artwork by a known artist -> ALWAYS "search", never "generate".
    Prefer museum, Wikimedia, official collection, archive, or other credible
    source pages. If the exact artwork cannot be found, skip the image rather
    than invent it.
  • Real people, real places, museum halls, historical artifacts, architecture,
    maps, plans, technical diagrams, and software screenshots -> "search".
    Never generate pseudo-photographs of real people/places, fake maps, fake
    museum plans, fake historical documents, or pseudo-screenshots.
  • Software/program UI -> search for a real screenshot or official docs image.
    If none is confidently available, describe the UI in text or use a Mermaid
    diagram; do NOT generate a fake screenshot.
  • Real map/plan/schema (e.g. Hermitage floor plan) -> search for the real
    image/source. If not found, do not hallucinate the plan. Use a textual
    explanation or high-level Mermaid diagram only if it is clearly conceptual.
  • Technically precise or mechanically detailed subjects we cannot draw
    correctly -> "search" only, NEVER "generate". Examples: a specific car's
    engine, its belt-routing/serpentine diagram, a wiring or circuit schematic,
    an anatomical chart, a chemical apparatus, an exploded parts view, or any
    exact technical diagram. These are wrong the instant a single detail is off,
    and a generated one only looks authoritative while being false. If a real
    image cannot be found, SKIP the image — show nothing. Truthfulness over
    completeness: a missing image beats a confident, wrong one.
  • Artist workspace, table setup, material layout, abstract workflow, or
    custom teaching scene -> usually "generate", because a perfectly matching
    real photo is unlikely.
  • When unsure whether something exists, try search first. Use "generate" only
    when the image is intentionally illustrative rather than evidentiary.

Use a gallery instead of a single image when the paragraph benefits from
comparison or several examples: 2-6 works by an artist, multiple views of a
museum hall, a sequence of historical photos, several portraits of one person
from a period, before/after examples, or multiple UI states. Keep each gallery
coherent: one reason to look at all images together, not a random dump.

Return widgets in five separate arrays:
- imageWidgets: [{id, mode ("search"|"generate"), description (short UI caption in ${lang}), prompt (internal search/generation prompt in ${lang}), alt (in ${lang}), url (direct image url or ""), source (page url or "")}]
- galleryWidgets: [{id, caption (in ${lang}), items: [{mode ("search"|"generate"), description (short UI caption in ${lang}), prompt (internal search/generation prompt in ${lang}), alt (in ${lang}), url (direct image url or ""), source (page url or "")}]}]
- diagramWidgets: [{id, source (Mermaid source), caption (in ${lang})}]
- videoWidgets: [{id, url (watch url), title, recommended_by (url of the
  recommendation source — REQUIRED, never "" unless you skip the video),
  why (one sentence in ${lang})}]
- interactiveWidgets: [{id, title (in ${lang}), description (in ${lang}),
  html (body content, NO html/head/body tags), css, js, height (integer
  pixels, 160-640)}]

If a category is unused, return an empty array [].

${
  braveApiKey
    ? `You have web access through the Brave Search MCP tools:
- mcp__brave__brave_web_search — for verifying facts, finding concrete
  examples, current best practices, citations, and for finding
  good YouTube/Vimeo videos. Try queries like "<topic> lecture youtube",
  "<topic> demo youtube", "best youtube videos to learn X reddit",
  "<topic> recommended video tutorials site:reddit.com", "<topic> syllabus video".
- mcp__brave__brave_image_search — for REAL image URLs for image and
  gallery widgets.

Codex's built-in web search is also available — use whichever fits.
`
    : `Use Codex's built-in web search where useful to verify facts and
find concrete examples + useful YouTube/Vimeo videos. For image and gallery
widgets, use web search to find credible public source pages when the exact
real image matters. Put the page URL in "source"; put "url" only if you are
confident it is a direct real image URL. Source-only is useful: the app will
extract og:image, srcset, JSON-LD, and large image assets from the page later.
`
}
You also have built-in read-only reference MCP tools:
- Context7 MCP (resolve-library-id, query-docs) for current library/framework/
  API/CLI/cloud-service documentation. Use it for programming and tool-specific
  course material instead of relying on stale memory.
- Wikimedia/MediaWiki MCP (search-page, get-page, get-file, list-wikis) for
  Wikimedia Commons, English Wikipedia, and Russian Wikipedia. Use it for
  artworks, museum objects, public-domain media, encyclopedia pages, real maps,
  file metadata, and Commons image URLs before falling back to general search.

SOURCES: at the end, return a "sources" array listing every URL you
ACTUALLY consulted while writing this submodule. Be honest — do not
invent URLs, do not include sources you didn't read. If you wrote
entirely from internal knowledge with no web lookups, return [].

EDITOR PASS — before returning, re-read your draft and fix it as a careful
editor + fact-checker. Do this silently; return only the polished result:
1. Punctuation — fix errors.
2. Typography for "${lang}" — proper quotes («» in Russian, "" in English),
   em-dashes — where appropriate, no double spaces, proper ellipses (…),
   non-breaking spaces where idiomatic.
3. Factual claims — verify them (use web search). Fix what's wrong; if you
   cannot verify a load-bearing claim, soften it or drop it.
4. Consistency — do not contradict the previous submodules above; reuse their
   terminology and level assumptions.
5. Flow — light polish only; do NOT restructure or change the voice.
Put a 1-3 sentence log of what you changed in "notes" (empty string if nothing).

${languageStyleGuide(lang)}`;
  onProgress?.({ label: "thinking" });
  const text = await runStreamed(prompt, draftSchema, onProgress, {
    braveApiKey,
    modelConfig,
    dirs: spaceDirs,
  });
  const parsed = JSON.parse(text);
  if (!parsed?.article || typeof parsed.article !== "string") {
    throw new Error("Codex returned no article");
  }
  return {
    article: parsed.article.trim(),
    notes: typeof parsed.notes === "string" ? parsed.notes.trim() : "",
    widgets: mergeWidgets(
      parsed.imageWidgets,
      parsed.galleryWidgets,
      parsed.diagramWidgets,
      parsed.videoWidgets,
      parsed.interactiveWidgets
    ),
    sources: normalizeSources(parsed.sources),
  };
}

function mergeWidgets(
  imageWidgets,
  galleryWidgets,
  diagramWidgets,
  videoWidgets,
  interactiveWidgets
) {
  const out = {};
  if (Array.isArray(imageWidgets)) {
    for (const w of imageWidgets) {
      if (w && typeof w.id === "string" && w.id.trim()) {
        const url = typeof w.url === "string" ? w.url.trim() : "";
        out[w.id.trim()] = {
          type: "image",
          placeholder: !url,
          mode: w.mode === "generate" ? "generate" : "search",
          description: typeof w.description === "string" ? w.description.trim() : "",
          prompt:
            typeof w.prompt === "string" && w.prompt.trim()
              ? w.prompt.trim()
              : typeof w.description === "string"
                ? w.description.trim()
                : "",
          alt: typeof w.alt === "string" ? w.alt.trim() : "",
          ...(url ? { url } : {}),
          ...(typeof w.source === "string" && w.source.trim()
            ? { source: w.source.trim() }
            : {}),
        };
      }
    }
  }
  if (Array.isArray(galleryWidgets)) {
    for (const w of galleryWidgets) {
      if (!w || typeof w.id !== "string" || !w.id.trim()) continue;
      const items = Array.isArray(w.items)
        ? w.items
            .map((item) => {
              if (!item) return null;
              const url = typeof item.url === "string" ? item.url.trim() : "";
              return {
                type: "image",
                mode: item.mode === "generate" ? "generate" : "search",
                description:
                  typeof item.description === "string" ? item.description.trim() : "",
                prompt:
                  typeof item.prompt === "string" && item.prompt.trim()
                    ? item.prompt.trim()
                    : typeof item.description === "string"
                      ? item.description.trim()
                      : "",
                alt: typeof item.alt === "string" ? item.alt.trim() : "",
                ...(url ? { url } : {}),
                ...(typeof item.source === "string" && item.source.trim()
                  ? { source: item.source.trim() }
                  : {}),
                placeholder: !url,
              };
            })
            .filter((item) => item && (item.description || item.prompt || item.url))
        : [];
      if (items.length > 0) {
        out[w.id.trim()] = {
          type: "gallery",
          caption: typeof w.caption === "string" ? w.caption.trim() : "",
          items: items.slice(0, 6),
        };
      }
    }
  }
  if (Array.isArray(diagramWidgets)) {
    for (const w of diagramWidgets) {
      if (w && typeof w.id === "string" && w.id.trim()) {
        out[w.id.trim()] = {
          type: "diagram",
          source: typeof w.source === "string" ? w.source.trim() : "",
          caption: typeof w.caption === "string" ? w.caption.trim() : "",
        };
      }
    }
  }
  if (Array.isArray(videoWidgets)) {
    for (const w of videoWidgets) {
      if (!w || typeof w.id !== "string" || !w.id.trim()) continue;
      const url = typeof w.url === "string" ? w.url.trim() : "";
      if (!url) continue;
      out[w.id.trim()] = {
        type: "video",
        url,
        title: typeof w.title === "string" ? w.title.trim() : "",
        recommended_by:
          typeof w.recommended_by === "string" ? w.recommended_by.trim() : "",
        why: typeof w.why === "string" ? w.why.trim() : "",
      };
    }
  }
  if (Array.isArray(interactiveWidgets)) {
    for (const w of interactiveWidgets) {
      if (!w || typeof w.id !== "string" || !w.id.trim()) continue;
      out[w.id.trim()] = {
        type: "interactive",
        title: typeof w.title === "string" ? w.title.trim() : "",
        description: typeof w.description === "string" ? w.description.trim() : "",
        html: typeof w.html === "string" ? w.html : "",
        css: typeof w.css === "string" ? w.css : "",
        js: typeof w.js === "string" ? w.js : "",
        height:
          typeof w.height === "number"
            ? Math.max(160, Math.min(640, Math.round(w.height)))
            : 320,
      };
    }
  }
  return out;
}

function stripUnknownWidgetMarkers(article, widgets) {
  const ids = new Set(Object.keys(widgets || {}));
  return String(article || "")
    .split("\n")
    .filter((line) => {
      const match = /^::widget\{[^}]*id="([^"]+)"[^}]*\}\s*$/.exec(line.trim());
      return !match || ids.has(match[1]);
    })
    .join("\n")
    .trim();
}

const illustrationPlanSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    article: { type: "string" },
    imageWidgets: draftSchema.properties.imageWidgets,
    galleryWidgets: draftSchema.properties.galleryWidgets,
  },
  required: ["article", "imageWidgets", "galleryWidgets"],
};

export async function planIllustrations(
  { topic, language, article, widgets, braveApiKey, modelConfig },
  ctx
) {
  const lang = (language || "en").trim();
  const existingWidgets = widgets && typeof widgets === "object" ? widgets : {};
  const existingIds = Object.keys(existingWidgets).sort();
  const prompt = `You are doing the illustration pass for one already-written
course submodule on "${topic}" (language: ${lang}).

Your job is NOT to rewrite the article. Keep the prose exactly as-is except
for inserting image/gallery widget marker lines after paragraphs where a visual
will materially help comprehension.

Article:
<article>
${article}
</article>

Existing widgets:
<widgets>
${JSON.stringify(existingWidgets, null, 2)}
</widgets>

Existing widget ids: ${existingIds.join(", ") || "(none)"}

Do a silent paragraph-by-paragraph pass. For every paragraph, decide ONE of:
- nothing — the prose stands on its own; leave it unchanged.
- a real image/gallery would help the learner understand faster — a concrete
  object, place, artwork, diagram-like visual reference, comparison set, setup,
  material layout, or example the learner should inspect. Insert a widget marker
  and choose how to find it ("search" for a real existing thing, "generate" for
  a conceptual teaching scene).
- the point is really a code or AI/LLM / text artifact — a code pattern or
  before/after, a prompt or system prompt, a context window, a tool/function
  schema, a JSON or config payload, command output, or logs — OR it is software
  UI (an app/program/editor/IDE window, an inspector or properties panel, a
  dashboard, a settings screen, a menu, a toolbar, or any app/website
  screenshot) — where a searched or generated picture would be meaningless,
  hallucinated, or almost never findable. Do NOT add an image here; instead
  write a concrete, self-authored Markdown fenced code block INLINE, or describe
  the interface in prose.
Only add an image when the subject is a concrete, real, FINDABLE thing. If you
are not confident a real image can actually be found, do NOT add the widget —
a missing image beats an empty placeholder. Do not decorate every paragraph.

Rules:
- Preserve all existing widget marker lines and existing ids.
- Add at most 3 NEW image/gallery widgets total, and only clearly findable ones.
- Use ids that do not collide with existing ids, e.g. img-auto-1,
  img-auto-2, gal-auto-1.
- New marker lines must be alone, with blank lines around them:
  ::widget{type="image" id="img-auto-1"}
  ::widget{type="gallery" id="gal-auto-1"}
- Return the full article with only these marker-line and fenced-code-block insertions.
- Do not add diagrams, videos, interactive widgets, or headings, and do not
  rewrite the existing prose. You MAY insert new Markdown fenced code blocks as
  described above; otherwise keep the wording as-is.

Image/gallery mode:
- "search" for real, specific, existing things: named artworks, real people,
  real places, artifacts, museum halls, architecture, maps/plans, technical
  diagrams, and real screenshots. Never generate fake versions of those.
- "generate" only for intentionally conceptual teaching scenes: idealized
  workspace, staged practice setup, material layout, abstract workflow, or
  custom explanatory illustration.
- Famous artworks by known artists are always "search".
- If unsure whether a real thing exists, use "search".

For each new image item provide a short display description and short alt text
in language "${lang}". Keep image fields separate:
- description: short learner-facing caption, 1 sentence, not a search prompt.
- prompt: internal search target or generation prompt. For search, name the
  exact real thing to find. For generate, describe subject, style, composition,
  lighting, and important objects.
Use a gallery only when several images are needed for one comparison.

Return only NEW image/gallery widgets. If no new visual is useful, return the
unchanged article and empty arrays.`;
  ctx?.progress?.({ label: "marking", detail: "paragraph-by-paragraph visual pass" });
  const text = await runStreamed(prompt, illustrationPlanSchema, ctx?.progress, {
    braveApiKey,
    modelConfig,
  });
  const parsed = JSON.parse(text);
  const additions = mergeWidgets(
    parsed.imageWidgets,
    parsed.galleryWidgets,
    [],
    [],
    []
  );
  const merged = { ...existingWidgets };
  for (const [id, widget] of Object.entries(additions)) {
    if (!merged[id]) merged[id] = widget;
  }
  const plannedArticle =
    typeof parsed.article === "string" && parsed.article.trim()
      ? parsed.article.trim()
      : String(article || "");
  return {
    article: stripUnknownWidgetMarkers(plannedArticle, merged),
    widgets: merged,
  };
}

function normalizeSources(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((s) => {
      if (!s || typeof s.url !== "string" || !s.url.trim()) return null;
      return {
        title: typeof s.title === "string" ? s.title.trim() : "",
        url: s.url.trim(),
      };
    })
    .filter(Boolean);
}

const reviewSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    article: { type: "string" },
    notes: { type: "string" },
  },
  required: ["article", "notes"],
};

/** Stage 2 — editor + fact-check + consistency pass. */
export async function submoduleReview(params, ctx) {
  return await reviewArticle(params, ctx?.progress);
}

async function reviewArticle(
  { article, language, topic, previousArticles, modelConfig },
  onProgress
) {
  const lang = (language || "en").trim();
  const prompt = `You are reviewing one submodule article from a course on
"${topic}" (language: ${lang}). Act as a careful editor + fact-checker.

Tasks, in order:
1. Punctuation — fix any errors.
2. Typography — proper quotes for the target language (e.g. «» in Russian,
   "" in English), em-dashes — where appropriate, no double spaces, proper
   ellipses (…), non-breaking spaces where idiomatic.
3. Factual claims — verify them (use web search). If something is wrong,
   fix it. If you cannot verify and the claim carries weight, soften the
   language or remove the unsubstantiated bit.
4. Internal consistency — check this article against the previous submodules
   shown below. If there are contradictions (terminology, facts, level
   assumptions, etc.), resolve them in favor of what's already established.
5. Light polish for flow — do NOT rewrite the voice or restructure.
6. Preserve every ::widget{...} marker line EXACTLY as-is — never remove, move,
   merge, reword, or translate them, and keep the blank lines around them.

${prevArticlesBlock(previousArticles, lang)}Article to review:
<article>
${article}
</article>

${languageStyleGuide(lang)}

Return the full revised article in "article" and a brief log of fixes in
"notes" (empty string if nothing changed materially).`;
  onProgress?.({ label: "reviewing" });
  const text = await runStreamed(prompt, reviewSchema, onProgress, { modelConfig });
  const parsed = JSON.parse(text);
  return {
    article:
      typeof parsed?.article === "string" && parsed.article.trim()
        ? parsed.article.trim()
        : article,
    notes: typeof parsed?.notes === "string" ? parsed.notes.trim() : "",
  };
}

/**
 * Stage 3 — validate widgets. JS-only Mermaid sanity check; flags bad
 * diagrams so the UI can render an error block. No LLM call yet — kept
 * thin to allow LLM-assisted fix later.
 */
export async function submoduleAnnotate(params, ctx) {
  ctx?.progress?.({ label: "validating" });
  const widgets = params?.widgets || {};
  const out = {};
  let diagChecked = 0;
  let diagBad = 0;
  let intChecked = 0;
  let intRepaired = 0;
  let intBroken = 0;
  for (const [id, w] of Object.entries(widgets)) {
    if (w?.type === "diagram") {
      diagChecked++;
      const issue = mermaidIssue(w.source);
      if (issue) {
        diagBad++;
        out[id] = { ...w, error: issue };
        ctx?.progress?.({ label: "validating", detail: `${id}: ${issue}` });
      } else {
        out[id] = w;
      }
    } else if (w?.type === "interactive") {
      intChecked++;
      const { final, error, repairs } = await validateAndRepairInteractive(
        w,
        id,
        ctx,
        params?.braveApiKey,
        params?.modelConfig
      );
      if (repairs > 0 && !error) intRepaired++;
      if (error) {
        intBroken++;
        out[id] = { ...final, error };
      } else {
        out[id] = final;
      }
    } else {
      out[id] = w;
    }
  }
  const noteParts = [];
  if (diagChecked > 0) noteParts.push(`Mermaid: ${diagBad}/${diagChecked} flagged`);
  if (intChecked > 0)
    noteParts.push(
      `Interactive: ${intChecked} checked, ${intRepaired} repaired, ${intBroken} broken`
    );
  const notes = noteParts.length > 0 ? noteParts.join("; ") + "." : "";
  return { article: params.article, widgets: out, notes };
}

const INTERACTIVE_MAX_REPAIRS = 2;

const WIDGET_SEVERITIES = ["critical", "minor"];

function widgetReviewPrompt(title, description) {
  return `You are reviewing a SCREENSHOT of a rendered interactive learning widget to check it actually renders correctly.

Widget title: ${title || "(none)"}
What it should let the learner do: ${description || "(none)"}

Judge ONLY real rendering failures:
- Is anything actually rendered (NOT a blank/empty/white/black area)?
- Is the layout geometrically intact: text not clipped or cut off, elements not overlapping or spilling outside the frame, controls and labels readable and reasonably sized?
- For drawings/diagrams (e.g. a perspective cube): are the shapes coherent — lines meet where they should, no obviously broken or garbled geometry?
Do NOT nitpick anti-aliasing, exact fonts, pixel-perfect spacing, color/theme choices, or light vs dark.

Severity: "critical" = blank, unusable, or broken geometry/layout that defeats the widget's purpose; "minor" = cosmetic only.

Output ONLY a single-line JSON object:
{"ok":<true if it renders correctly>,"defects":[{"text":"<what is wrong>","severity":"critical|minor"}],"summary":"<one short sentence>"}`;
}

function normalizeWidgetReview(parsed) {
  const defects = Array.isArray(parsed?.defects)
    ? parsed.defects
        .filter((d) => d && typeof d.text === "string" && d.text.trim())
        .map((d) => ({
          text: d.text.trim(),
          severity: WIDGET_SEVERITIES.includes(String(d.severity).toLowerCase())
            ? String(d.severity).toLowerCase()
            : "minor",
        }))
    : [];
  const ok = parsed?.ok === true && !defects.some((d) => d.severity === "critical");
  return { ok, defects, summary: typeof parsed?.summary === "string" ? parsed.summary.trim() : "" };
}

export async function reviewWidgetRender({ title, description, pngPath, braveApiKey, modelConfig }, ctx) {
  const input = [
    { type: "text", text: widgetReviewPrompt(title, description) },
    { type: "local_image", path: pngPath },
  ];
  ctx?.progress?.({ label: "validating", detail: "visual check" });
  const thread = makeCodex(braveApiKey).startThread(threadOptions({ braveApiKey, modelConfig }));
  const turn = await thread.run(input);
  return normalizeWidgetReview(extractJsonLoose(turn.finalResponse));
}

async function visualCheck(widget, id, braveApiKey, modelConfig, ctx) {
  if (!(await rendererAvailable())) return null;
  ctx?.progress?.({ label: "validating", detail: `${id}: rendering` });
  const out = join(tmpdir(), `wv-${id}-${process.pid}-${Date.now()}.png`);
  const png = await renderWidgetPng(widget, out);
  if (!png) return null;
  try {
    const review = await reviewWidgetRender(
      { title: widget.title, description: widget.description, pngPath: png, braveApiKey, modelConfig },
      ctx
    );
    if (review.ok) return null;
    const critical = review.defects.filter((d) => d.severity === "critical").map((d) => d.text);
    if (critical.length === 0) return null;
    return `render looks broken: ${critical.slice(0, 2).join("; ")}`;
  } finally {
    try {
      unlinkSync(png);
    } catch {}
  }
}

async function validateAndRepairInteractive(widget, id, ctx, braveApiKey, modelConfig) {
  let current = widget;
  let lastError = await validateInteractive(current);
  if (!lastError) lastError = await visualCheck(current, id, braveApiKey, modelConfig, ctx);
  if (!lastError) return { final: current, error: null, repairs: 0 };
  ctx?.progress?.({ label: "validating", detail: `${id}: ${lastError}` });
  for (let attempt = 1; attempt <= INTERACTIVE_MAX_REPAIRS; attempt++) {
    ctx?.progress?.({
      label: "validating",
      detail: `${id}: repair ${attempt}/${INTERACTIVE_MAX_REPAIRS}`,
    });
    let repaired;
    try {
      repaired = await repairInteractiveCodex(current, lastError, braveApiKey, modelConfig);
    } catch (e) {
      lastError = `repair call failed: ${e?.message || e}`;
      break;
    }
    if (!repaired) {
      lastError = `repair returned no widget`;
      break;
    }
    current = { ...current, ...repaired };
    lastError = await validateInteractive(current);
    if (!lastError) lastError = await visualCheck(current, id, braveApiKey, modelConfig, ctx);
    if (!lastError) return { final: current, error: null, repairs: attempt };
    ctx?.progress?.({ label: "validating", detail: `${id}: ${lastError}` });
  }
  return { final: current, error: lastError, repairs: INTERACTIVE_MAX_REPAIRS };
}

const repairSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    html: { type: "string" },
    css: { type: "string" },
    js: { type: "string" },
    height: { type: "integer" },
  },
  required: ["html", "css", "js", "height"],
};

async function repairInteractiveCodex(widget, errorMsg, braveApiKey, modelConfig) {
  const prompt = repairPrompt(widget, errorMsg);
  const text = await runOnce(prompt, repairSchema, { braveApiKey, modelConfig });
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return {
    html: typeof parsed.html === "string" ? parsed.html : widget.html,
    css: typeof parsed.css === "string" ? parsed.css : widget.css,
    js: typeof parsed.js === "string" ? parsed.js : widget.js,
    height:
      typeof parsed.height === "number"
        ? Math.max(160, Math.min(640, Math.round(parsed.height)))
        : widget.height,
  };
}

function mermaidIssue(source) {
  let s = (source || "").trim();
  if (!s) return "empty source";
  // Skip a leading init directive (%%{...}%%) and/or YAML front matter
  // (---\n…\n---) so a valid diagram that opens with one isn't misread.
  s = s.replace(/^%%\{[\s\S]*?\}%%\s*/, "");
  s = s.replace(/^---\s*[\s\S]*?\n---\s*/, "");
  s = s.replace(/^%%\{[\s\S]*?\}%%\s*/, "").trim();
  if (!s) return "empty source";
  const KNOWN = new Set([
    "graph", "flowchart", "sequenceDiagram", "classDiagram",
    "stateDiagram", "stateDiagram-v2", "erDiagram", "journey",
    "gantt", "pie", "gitGraph", "C4Context", "mindmap", "timeline",
    "quadrantChart", "block-beta", "sankey-beta", "xychart-beta",
    "packet-beta", "requirementDiagram",
  ]);
  const first = s.split(/\s+/, 1)[0];
  if (!KNOWN.has(first)) return `unknown diagram type "${first}"`;
  // Bracket balance is intentionally NOT checked: valid node labels (and a
  // course ABOUT Mermaid) legitimately contain [, ], (, ), { or }, which made
  // the naive count flag good diagrams. The client renders with the real
  // Mermaid parser and surfaces any genuine syntax/truncation error.
  return null;
}

const diagramFixSchema = {
  type: "object",
  additionalProperties: false,
  properties: { source: { type: "string" }, caption: { type: "string" } },
  required: ["source", "caption"],
};

/**
 * Repair / edit one diagram or interactive widget on demand. Mirrors the Claude
 * agent; reuses the codex validate+repair pipeline.
 * @returns {Promise<{ widget: object }>}
 */
export async function fixWidget(
  { language, topic, article, widget, instruction, braveApiKey, modelConfig },
  ctx
) {
  const w = widget && typeof widget === "object" && widget.widget ? widget.widget : widget;
  const lang = (language || "en").trim();
  const type = w?.type;
  const instr = (instruction || "").trim();
  const lessonCtx = (article || "").slice(0, 6000);
  if (type === "diagram") {
    const prompt = `You are fixing a Mermaid DIAGRAM in a lesson on "${topic}" (language "${lang}").
Current Mermaid source:
<source>
${w.source || ""}
</source>
${w.error ? `Known render error: ${w.error}\n` : ""}${instr ? `Learner's instruction: ${instr}\n` : ""}Lesson context (keep the diagram faithful to it):
<lesson>
${lessonCtx}
</lesson>
Return a corrected, VALID Mermaid diagram (labels in "${lang}") and a short caption (may be empty).`;
    const text = await runStreamed(prompt, diagramFixSchema, ctx?.progress, { braveApiKey, modelConfig });
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = {};
    }
    const source =
      typeof parsed.source === "string" && parsed.source.trim() ? parsed.source.trim() : w.source;
    const out = { source, error: mermaidIssue(source) || null };
    if (typeof parsed.caption === "string" && parsed.caption.trim()) out.caption = parsed.caption.trim();
    return { widget: out };
  }
  if (type === "interactive") {
    let current = {
      html: w.html || "",
      css: w.css || "",
      js: w.js || "",
      height: w.height,
      title: w.title,
      description: w.description,
    };
    if (instr) {
      const prompt = `You are editing a SELF-CONTAINED interactive widget (vanilla JS only; no network, no eval, no external libs) in a lesson on "${topic}" (language "${lang}").
Current HTML:\n${current.html}\nCurrent CSS:\n${current.css}\nCurrent JS:\n${current.js}
${w.error ? `Known error: ${w.error}\n` : ""}Learner's instruction: ${instr}`;
      const text = await runStreamed(prompt, repairSchema, ctx?.progress, { braveApiKey, modelConfig });
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      if (parsed && typeof parsed === "object") {
        current = {
          ...current,
          html: typeof parsed.html === "string" ? parsed.html : current.html,
          css: typeof parsed.css === "string" ? parsed.css : current.css,
          js: typeof parsed.js === "string" ? parsed.js : current.js,
          height: typeof parsed.height === "number" ? parsed.height : current.height,
        };
      }
    }
    const { final, error } = await validateAndRepairInteractive(current, "fix", ctx, braveApiKey, modelConfig);
    return {
      widget: {
        html: final.html,
        css: final.css,
        js: final.js,
        height: final.height,
        error: error || null,
      },
    };
  }
  return { widget: {} };
}

/**
 * Composite kept for back-compat / smoke tests. Rust drives the stages
 * individually for per-stage progress events.
 */
export async function generateSubmodule(params) {
  if (!params.modulePath?.title || !params.submodulePath?.title) {
    throw new Error("modulePath and submodulePath must include titles");
  }
  const drafted = await draftArticleInternal(params);
  const reviewed = await reviewArticle({ ...params, article: drafted.article });
  const validated = await submoduleAnnotate(
    { article: reviewed.article, widgets: drafted.widgets },
    undefined
  );
  return {
    article: validated.article,
    widgets: validated.widgets,
    review_notes: reviewed.notes,
  };
}

function buildRefinePrompt({
  topic,
  language,
  courseFormat,
  courseMd,
  currentStructure,
  memoryFiles,
  chatHistory,
  userMessage,
}) {
  const lang = (language || "en").trim();
  const memoryBlock =
    memoryFiles && memoryFiles.length
      ? `Past user feedback stored in memory (most recent last):\n${memoryFiles
          .map((f) => `--- ${f.filename} ---\n${f.content}`)
          .join("\n\n")}\n\n`
      : "";
  const chatBlock =
    chatHistory && chatHistory.length
      ? `Refinement chat so far (most recent last):\n${chatHistory
          .map((m) => `${m.role}: ${m.text}`)
          .join("\n")}\n\n`
      : "";
  return `You are iterating on a course curriculum on "${topic}" (language: ${lang}).

${courseFormatGuide(courseFormat, lang)}

Course brief (wizard Q&A):
<course-md>
${courseMd}
</course-md>

Current accepted structure:
<structure>
${JSON.stringify(currentStructure, null, 2)}
</structure>

${memoryBlock}${chatBlock}User's latest message: ${userMessage}

Decide:
A) If the user's intent is clear enough — propose a FULL revised tree. Briefly
   explain in "reply" what you changed and why. Respect everything from the
   course brief and memory.
B) If unclear or you'd like to negotiate — ask one specific clarifying question
   in "reply". Set "modules" to []. Do NOT propose half a tree.

All titles and summaries in language "${lang}". When proposing, return the
FULL tree, not a diff. The tree size must follow the chosen generation format.

${languageStyleGuide(lang)}`;
}

function normalizeRefineResponse(parsed) {
  if (!parsed || typeof parsed.reply !== "string") {
    throw new Error("response missing 'reply'");
  }
  const reply = parsed.reply.trim();
  const rawModules = Array.isArray(parsed.modules) ? parsed.modules : [];
  const modules = rawModules
    .filter((m) => m && typeof m.title === "string" && m.title.trim())
    .map((m) => ({
      title: m.title.trim(),
      summary: typeof m.summary === "string" ? m.summary.trim() : "",
      submodules: Array.isArray(m.submodules)
        ? m.submodules
            .filter((s) => s && typeof s.title === "string" && s.title.trim())
            .map((s) => ({
              title: s.title.trim(),
              summary: typeof s.summary === "string" ? s.summary.trim() : "",
            }))
        : [],
    }));
  return { reply, modules };
}

const refineSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    reply: { type: "string" },
    modules: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          summary: { type: "string" },
          submodules: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                title: { type: "string" },
                summary: { type: "string" },
              },
              required: ["title", "summary"],
            },
          },
        },
        required: ["title", "summary", "submodules"],
      },
    },
  },
  required: ["reply", "modules"],
};

/**
 * @param {{topic:string, language:string, courseFormat?:string, courseMd:string, currentStructure:object, memoryFiles:{filename:string,content:string}[], chatHistory:{role:string,text:string}[], userMessage:string}} params
 */
export async function refineStructure(params, ctx) {
  if (typeof params?.userMessage !== "string" || !params.userMessage.trim()) {
    throw new Error("userMessage must be a non-empty string");
  }
  const prompt = buildRefinePrompt(params);
  const text = await runStreamed(prompt, refineSchema, ctx?.progress, {
    modelConfig: params.modelConfig,
  });
  const parsed = JSON.parse(text);
  return normalizeRefineResponse(parsed);
}

/**
 * @param {{ courseMd: string, topic: string, language: string, courseFormat?: string }} params
 */
export async function buildStructure(
  {
    courseMd,
    topic,
    language,
    courseFormat,
    modelConfig,
    spaceSources,
    spaceLinks,
    spaceDirs,
    spaceStrict,
  },
  ctx
) {
  if (typeof topic !== "string" || !topic.trim()) {
    throw new Error("topic must be a non-empty string");
  }
  if (typeof courseMd !== "string" || !courseMd.trim()) {
    throw new Error("courseMd must be a non-empty string");
  }
  const lang = (language || "en").trim();
  const prompt = `You are designing a personalized course on "${topic}".
The course will be delivered in language code "${lang}".

${courseFormatGuide(courseFormat, lang)}

Below is the course brief — a markdown file with the wizard Q&A.

<course-md>
${courseMd}
</course-md>
${spaceContextBlock(spaceSources, spaceLinks, lang, spaceStrict, spaceDirs)}
First generate a short display title for the whole course. It must NOT copy the
learner's raw request verbatim. Make it a concise noun phrase, 2-6 words,
written in language "${lang}", with no quotes and no "course about/on" wrapper.

Then design a curriculum: a list of top-level modules, each with a few submodules.

Research first. Before sketching anything, web-search how this subject is
taught in serious places: university programs (especially the best ones —
top art academies, top engineering schools, etc. as relevant), well-regarded
online courses, established certifications, and the canonical reading paths
practitioners recommend. Use the convergence of those programs as your skeleton.
Use Context7 when the subject depends on current library/framework/API docs.
Use Wikimedia/MediaWiki for art/history/museum/public-domain media topics when
that gives a more authoritative source than general search.
If multiple traditions exist (e.g. русская академическая vs European atelier),
acknowledge them and pick the one that best fits the learner's goals from the
brief. Never improvise a structure from intuition when established programs
exist.

Constraints:
- Reflect the learner's specific goals, prior knowledge, and constraints.
- Skip modules irrelevant to those goals; do not produce a generic textbook.
- Follow the chosen generation format exactly for module/submodule counts and tone.
- All titles and summaries in language "${lang}".
- For NON-LINEAR subjects, if a submodule genuinely requires understanding an EARLIER submodule first, list those earlier submodule titles verbatim in its "prereqs". For linear/sequential courses where each part simply follows the previous, leave "prereqs" empty. Never list a later submodule and never create cycles.

${languageStyleGuide(lang)}

Also classify this course into exactly ONE category id from this fixed list
(pick the single best fit; use "general" only when nothing else clearly fits):
${categoryClassifyGuide()}`;

  const submoduleSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      title: { type: "string" },
      summary: { type: "string" },
      prereqs: {
        type: "array",
        items: { type: "string" },
        description:
          "Titles of EARLIER submodules this one depends on (non-linear courses only); empty for linear/sequential courses.",
      },
    },
    required: ["title", "summary", "prereqs"],
  };

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      category: { type: "string", enum: CATEGORY_IDS },
      title: { type: "string" },
      modules: {
        type: "array",
        minItems: 4,
        maxItems: 10,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string" },
            summary: { type: "string" },
            submodules: {
              type: "array",
              minItems: 2,
              maxItems: 6,
              items: submoduleSchema,
            },
          },
          required: ["title", "summary", "submodules"],
        },
      },
    },
    required: ["category", "title", "modules"],
  };

  const text = await runStreamed(prompt, schema, ctx?.progress, {
    modelConfig,
    dirs: spaceDirs,
    idleTimeoutMs: 180_000,
    totalTimeoutMs: 900_000,
  });
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed?.modules) || parsed.modules.length === 0) {
    throw new Error("Codex response missing non-empty 'modules' array");
  }
  // Drop modules without a usable title instead of throwing away the whole
  // (often otherwise-good) generation — same tolerance we already apply to
  // submodules below. The model occasionally appends a stray/blank module.
  const modules = parsed.modules
    .filter((m) => m && typeof m.title === "string" && m.title.trim())
    .map((m) => {
      const submodules = Array.isArray(m.submodules) ? m.submodules : [];
      return {
        title: m.title.trim(),
        summary: typeof m.summary === "string" ? m.summary.trim() : "",
        submodules: submodules
          .filter((s) => s && typeof s.title === "string" && s.title.trim())
          .map((s) => ({
            title: s.title.trim(),
            summary: typeof s.summary === "string" ? s.summary.trim() : "",
            prereqs: Array.isArray(s.prereqs)
              ? s.prereqs.filter((p) => typeof p === "string" && p.trim()).map((p) => p.trim())
              : [],
          })),
      };
    });
  if (modules.length === 0) {
    throw new Error("response had no modules with a title");
  }
  return {
    title: normalizeCourseTitle(parsed?.title),
    modules,
    category: normalizeCategory(parsed?.category),
  };
}

// Claude Agent SDK wrapper.
//
// Subscription auth: when ANTHROPIC_API_KEY is unset, the SDK uses the local
// `claude` CLI auth (Claude Pro/Max subscription). The Rust side strips
// ANTHROPIC_API_KEY from the spawned env to guarantee subscription billing.

import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { query } from "@anthropic-ai/claude-agent-sdk";

import {
  repairPrompt,
  validateInteractive,
  renderWidgetPng,
  rendererAvailable,
} from "../lib/interactive.mjs";
import { braveStdioServer } from "../lib/brave.mjs";
import * as devlog from "../lib/devlog.mjs";
import {
  context7StdioServer,
  mediawikiStdioServer,
  researchMcpServersForCategory,
  RESEARCH_MCP_ALLOWED_TOOLS,
} from "../lib/reference-mcp.mjs";
import {
  categoryClassifyGuide,
  categoryPreferredSourcesBlock,
  categoryPedagogyBlock,
  normalizeCategory,
} from "../lib/categories.mjs";
import {
  flashcardRulesBlock,
  gradeAnswerBlock,
  leechRewriteBlock,
  learnerProfileBlock,
  socraticBlock,
  factCheckBlock,
} from "../lib/pedagogy.mjs";
import {
  templateCatalogBlock,
  normalizeTemplateWidget,
  normalizeCodeLang,
} from "../lib/widget-templates.mjs";
import { lintMath, describeMathIssues } from "../lib/math-lint.mjs";

// Safety / medium guidance from the topic classifier (classifyTopic), woven into
// the structure prompt so the curriculum — and the submodule summaries lessons
// later read — reflect the cautious / video_heavy flags.
function contentGuidanceBlock(cautious, videoHeavy) {
  const parts = [];
  if (cautious)
    parts.push(
      "SAFETY: This is a sensitive or potentially dangerous subject. Treat it responsibly — keep it strictly educational, foreground safety and ethics, add clear caveats, and never include operational, harm-enabling detail. Reflect this care in module and submodule summaries."
    );
  if (videoHeavy)
    parts.push(
      "MEDIUM: This subject is learned mainly by WATCHING and is easy to find on YouTube (memes, demos, technique, cooking, UI walkthroughs). Favor a video-first plan — note in submodule summaries where short demonstration clips are the primary medium, so lessons lean on video widgets."
    );
  return parts.length ? `\n${parts.join("\n")}\n` : "";
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

// Prompt hint for user-attached course MCP servers (the tools themselves are
// wired up via the agent options; this tells the model they exist and why).
function customMcpBlock(customMcp) {
  const servers = Array.isArray(customMcp)
    ? customMcp.filter((s) => s && s.id && s.command)
    : [];
  if (!servers.length) return "";
  const lines = servers
    .map((s) => {
      const tools = Array.isArray(s.tools) && s.tools.length
        ? s.tools.map((t) => `mcp__${s.id}__${t}`).join(", ")
        : `tools under the mcp__${s.id}__ prefix`;
      return `- ${s.name || s.id}: ${tools}`;
    })
    .join("\n");
  return `\nUSER-ATTACHED MCP TOOLS: the learner connected these domain-specific tool
servers to this course — actively use them when they help research, verify, or
produce material (they often give live access to the actual tool/domain):
${lines}\n`;
}

function normalizeCourseFormat(value) {
  return [
    "academic_course",
    "mini_module",
    "podcast_series",
    "single_lesson",
    "encyclopedia",
    "documentation",
    "fact_check",
    "roadmap",
  ].includes(value)
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
  if (format === "single_lesson") {
    return `Generation format: single standalone lesson.
- This is ONE complete, self-contained lesson article — not a course. There is no curriculum, no other modules, and no previous or next lessons.
- Cover the requested topic end-to-end at the learner's level: motivation, core explanation, concrete examples, common pitfalls, and a short actionable wrap-up.
- Never reference "this course", "later modules", or future lessons.
- Keep tests and assignments small and focused strictly on this one lesson.`;
  }
  if (format === "fact_check") {
    return `Generation format: FACT-CHECK (single standalone lesson).
- This is ONE self-contained fact-check article — NOT a course. There is no curriculum, no other modules, and no previous or next lessons. Never reference "this course" or other lessons.
- What you verify is the CLAIM (the lesson topic), together with any source link or image given in the "FACT INPUT" section below.
- Structure the article exactly as:
  1. **Claim** — restate, in one clear sentence, the claim being checked.
  2. **Verdict** — open with ONE verdict, written in ${lang}, chosen from this scale: True / Mostly true / Mixed / Misleading / False / Unverifiable. Make it prominent (a bold line at the very top).
  3. **What the evidence shows** — explain the reasoning with concrete facts, figures, dates and context; address WHY the claim is true / false / partly true, and any important nuance.
  4. **Sources** — cite several authoritative, primary sources you actually consulted; every key factual statement must be traceable to a source.
- Research thoroughly and prioritise accuracy over persuasion. Stay neutral and analytical; never invent facts or sources. If the claim cannot be settled with available evidence, say so honestly (Unverifiable) and explain what would settle it.
- Do NOT generate tests or homework assignments for fact-check material.`;
  }
  if (format === "roadmap") {
    return `Generation format: learning ROADMAP.
- You are clarifying a learning GOAL to plan a roadmap — a vertical route of
  stages with skill nodes — NOT a course curriculum.
- Focus on: current level, the concrete end goal (job/project/exam), and any
  deadline or known sub-areas to include or skip.`;
  }
  if (format === "encyclopedia") {
    return `Generation format: ENCYCLOPEDIA.
- This is a reference encyclopedia: SECTIONS (top-level modules), each holding several self-contained reference ARTICLES (submodules) — an interlinked wiki, NOT a linear course.
- Structure: 2-8 sections, each with 2-8 articles. Group articles by theme; order is for browsing, not strict progression.
- Each article must be COMPLETE and stand on its own: overview/definition, key facts, details, context, and a closing "See also" with references. Never write "as we saw earlier" or "in the next lesson".
- Completeness and factual accuracy are paramount: research thoroughly and cite MORE sources than usual; prefer authoritative references.
- CROSS-LINK related articles: when you mention another article that exists in this encyclopedia (see the curriculum outline above), link it as a markdown link with this exact scheme: [Article Title](course://article/<Article Title>) — use the article's exact title; the app resolves it to in-app navigation. Link generously, but ONLY to titles that actually appear in the outline.
- Do NOT generate tests or homework assignments for encyclopedia material.`;
  }
  if (format === "documentation") {
    return `Generation format: DOCUMENTATION.
- This is reference DOCUMENTATION for how something works (a tool, system, API, library, product or process): SECTIONS (top-level modules) holding self-contained reference ARTICLES (submodules) — an interlinked docs site, NOT a linear course.
- Structure: 2-8 sections, each with 2-8 articles. Organise like real product docs: overview / getting started, concepts & how it works, components / reference, configuration & usage, troubleshooting / FAQ. Order is for navigation, not strict progression.
- Each article must be COMPLETE and stand on its own: what it is, HOW IT WORKS step by step, concrete usage with examples, the relevant options/parameters, and common gotchas. Never write "as we saw earlier" or "in the next lesson".
- Accuracy is paramount: document the ACTUAL behaviour of the thing. Research thoroughly and cite authoritative/primary sources (official docs, specs, source). Do NOT invent options, flags, or APIs that do not exist.
- CROSS-LINK related articles: when you mention another article that exists in this documentation (see the curriculum outline above), link it as a markdown link with this exact scheme: [Article Title](course://article/<Article Title>) — use the article's exact title; the app resolves it to in-app navigation. Link generously, but ONLY to titles that actually appear in the outline.
- Do NOT generate tests or homework assignments for documentation material.`;
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
  if (format === "single_lesson") {
    return `For the single-lesson wizard, ask at most a couple of laser-focused questions: the exact angle or use-case the learner wants covered, and their current level. Do NOT ask about weekly time budget, schedules, or course-scale preferences.`;
  }
  if (format === "fact_check") {
    return `For the fact-check wizard, the claim to verify is already given. Ask at most one short question only if the claim is ambiguous (which specific assertion, time frame, or scope to check). Do NOT ask about levels, schedules, tests, or visual assets.`;
  }
  if (format === "roadmap") {
    return `For the roadmap wizard, ask at most a couple of laser-focused questions: the learner's current level and the precise target outcome (job, project, exam). Do NOT ask about lesson formats, weekly schedules, tests, or visual assets.`;
  }
  if (format === "encyclopedia") {
    return `For the encyclopedia wizard, ask only what defines the scope of the reference work: the subject's boundaries (what to include/exclude), the depth and the target reader, and any key sub-areas or entries that must be covered. Do NOT ask about tests, homework, weekly schedules, or pacing.`;
  }
  if (format === "documentation") {
    return `For the documentation wizard, ask only what defines the scope of the docs: exactly WHAT is being documented (the specific tool/system/library and its version if relevant), its boundaries (what to include/exclude), the target reader and their level, and which areas must be covered (setup, concepts, configuration, API/reference, troubleshooting). Do NOT ask about tests, homework, weekly schedules, or pacing.`;
  }
  return "";
}

// Fact-check material: surface the user-provided fact to verify (a source URL
// to fetch, an attached image to examine, or extra text). The claim itself is
// the topic; this lists the attachments.
function factCheckInputBlock(courseFormat, factInput) {
  if (normalizeCourseFormat(courseFormat) !== "fact_check") return "";
  const fi = factInput && typeof factInput === "object" ? factInput : {};
  const lines = [];
  if (typeof fi.url === "string" && fi.url.trim()) {
    lines.push(
      `- Source link: ${fi.url.trim()}\n  Fetch and read this page (WebFetch) and base your verdict on what it actually says.`
    );
  }
  if (typeof fi.imagePath === "string" && fi.imagePath.trim()) {
    lines.push(
      `- An image was attached as the fact to check (path: ${fi.imagePath.trim()}). Examine the image and verify the claim it makes or that is made about it.`
    );
  }
  if (typeof fi.text === "string" && fi.text.trim()) {
    lines.push(`- Extra context from the user: ${fi.text.trim()}`);
  }
  const body = lines.length
    ? lines.join("\n")
    : "- No extra attachments; verify the claim stated in the lesson topic.";
  return `\nFACT INPUT (what to verify):\n${body}\n`;
}

// Per-page user directions ("what to write on this page") from the doc lesson
// modal. Highest-priority guidance for this single article.
function userInstructionsBlock(userInstructions) {
  const text = typeof userInstructions === "string" ? userInstructions.trim() : "";
  if (!text) return "";
  return `\nUSER INSTRUCTIONS FOR THIS PAGE (highest priority — follow them):
<page-instructions>
${text}
</page-instructions>
`;
}

// Documentation only: this page's place in the outline plus the other pages'
// titles/summaries/snippets, so an evolving doc set stays consistent.
function docPagesContextBlock(courseFormat, docPagesContext) {
  if (normalizeCourseFormat(courseFormat) !== "documentation") return "";
  const ctx = docPagesContext && typeof docPagesContext === "object" ? docPagesContext : {};
  const outline = Array.isArray(ctx.outlinePath) ? ctx.outlinePath.filter(Boolean) : [];
  const others = Array.isArray(ctx.otherPages) ? ctx.otherPages : [];
  if (!outline.length && !others.length) return "";
  const pos = outline.length ? `This page's place in the documentation: ${outline.join(" › ")}\n` : "";
  const pages = others
    .map((p) => {
      const title = typeof p?.title === "string" ? p.title.trim() : "";
      if (!title) return "";
      const summary =
        typeof p?.summary === "string" && p.summary.trim() ? ` — ${p.summary.trim()}` : "";
      const snippet =
        typeof p?.snippet === "string" && p.snippet.trim() ? `\n  excerpt: ${p.snippet.trim()}` : "";
      return `- ${title}${summary}${snippet}`;
    })
    .filter(Boolean)
    .join("\n");
  return `\nThis is ONE page of a larger DOCUMENTATION set that grows and changes over time. Write it to fit the whole: stay consistent in terminology and scope, cross-reference related pages where useful, and do NOT duplicate what other pages already cover.
<documentation-context>
${pos}${pages ? `Other pages in this documentation:\n${pages}\n` : ""}</documentation-context>
`;
}

function podcastNoWidgetGuide(courseFormat) {
  if (normalizeCourseFormat(courseFormat) !== "podcast_series") return "";
  return `PODCAST FORMAT OVERRIDE:
- Do not insert any ::widget markers.
- Return empty arrays for imageWidgets, galleryWidgets, diagramWidgets, videoWidgets, and templateWidgets.
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

async function runOnce(prompt, opts) {
  return await runStreamed(prompt, undefined, opts);
}

// Maps a { model, reasoning } config (from settings) onto Claude Agent SDK
// option fields. Blank fields are omitted so the agent uses its defaults.
// reasoning: "off" disables thinking; low/medium/high/xhigh/max set effort.
function modelOptions(modelConfig) {
  const out = {};
  const model = modelConfig?.model;
  if (typeof model === "string" && model.trim()) out.model = model.trim();
  const reasoning = modelConfig?.reasoning;
  if (typeof reasoning === "string" && reasoning.trim()) {
    const r = reasoning.trim().toLowerCase();
    if (r === "off" || r === "none" || r === "disabled") {
      out.thinking = { type: "disabled" };
    } else if (["low", "medium", "high", "xhigh", "max"].includes(r)) {
      out.effort = r;
    }
  }
  return out;
}

// Isolation applied to EVERY embedded agent call:
// - settingSources: [] — never load the user's global/project Claude settings.
//   Otherwise the SDK spawns their personal MCP servers (godot, blender, …) and,
//   if the model calls one, blocks on a permission prompt nothing can answer in
//   headless mode — hanging until the stage timeout fires (the ~40-min stall).
// - permissionMode: "dontAsk" — run only the tools we pre-approve via
//   allowedTools, deny anything else instantly instead of prompting (no hang).
const AGENT_ISOLATION = { settingSources: [], permissionMode: "dontAsk" };

function claudeCliOptions() {
  const cliPath = process.env.LEARN_ANYTHING_CLAUDE_CLI;
  return cliPath ? { pathToClaudeCodeExecutable: cliPath } : {};
}

function claudeBaseOptions(extra = {}) {
  return { ...AGENT_ISOLATION, ...claudeCliOptions(), ...extra };
}

const REFERENCE_MCP_ALLOWED_TOOLS = [
  "mcp__context7__resolve-library-id",
  "mcp__context7__query-docs",
  "mcp__mediawiki__list-wikis",
  "mcp__mediawiki__search-page",
  "mcp__mediawiki__search-page-by-prefix",
  "mcp__mediawiki__get-page",
  "mcp__mediawiki__get-pages",
  "mcp__mediawiki__get-file",
  "mcp__mediawiki__get-category-members",
  "mcp__mediawiki__get-links-here",
  "mcp__mediawiki__get-page-history",
  "mcp__mediawiki__get-revision",
  "mcp__mediawiki__get-site-info",
  "mcp__mediawiki__parse-wikitext",
  "mcp__mediawiki__compare-pages",
];

// Builds Claude Agent SDK options. When `web` is set, the agent gets the SDK's
// built-in WebSearch + WebFetch tools — native internet on subscription auth,
// no key needed. When braveApiKey is provided, the Brave MCP server is added
// too (its image search complements web search for finding real image URLs).
// Generous hard ceiling for agentic tool-use loops. NOT a research/quality
// knob — research effort is guided in the prompt; this is purely a runaway
// backstop set far above any real article's needs, so complex lessons are never
// aborted mid-generation with "max turns reached".
const MAX_AGENT_TURNS = 200;

function buildClaudeOptions({
  maxTurns,
  web,
  braveApiKey,
  modelConfig,
  dirs,
  category,
  stage,
  customMcp,
  resume,
} = {}) {
  const readDirs = Array.isArray(dirs) ? dirs.filter(Boolean) : [];
  const customServers = Array.isArray(customMcp)
    ? customMcp.filter((s) => s && typeof s.id === "string" && typeof s.command === "string")
    : [];
  const hasTools = web || !!braveApiKey || readDirs.length > 0 || customServers.length > 0;
  const options = {
    // Generous ceiling so the agent never errors with "max turns reached"
    // before it writes the article. Research depth is throttled in the prompt
    // (a few targeted lookups, then write), not by starving the turn budget.
    maxTurns: maxTurns ?? (hasTools ? MAX_AGENT_TURNS : 1),
    ...claudeBaseOptions(modelOptions(modelConfig)),
  };
  const allowedTools = [];
  if (web) {
    // WebSearch + WebFetch. Safe under permissionMode "dontAsk": both are
    // pre-approved (verified WebFetch runs for any domain without prompting,
    // so it can't hang the way it did under the default permission mode).
    allowedTools.push("WebSearch", "WebFetch");
    options.mcpServers = {
      ...(options.mcpServers || {}),
      context7: { type: "stdio", ...context7StdioServer() },
      mediawiki: { type: "stdio", ...mediawikiStdioServer() },
    };
    allowedTools.push(...REFERENCE_MCP_ALLOWED_TOOLS);
    // Domain research servers (arXiv/OpenAlex/Semantic Scholar/YouTube
    // transcripts), gated by category+stage to keep spawn overhead low.
    const research = researchMcpServersForCategory(category, stage);
    for (const [name, server] of Object.entries(research)) {
      options.mcpServers[name] = { type: "stdio", ...server };
      allowedTools.push(...(RESEARCH_MCP_ALLOWED_TOOLS[name] || []));
    }
  }
  if (braveApiKey) {
    options.mcpServers = {
      ...(options.mcpServers || {}),
      brave: { type: "stdio", ...braveStdioServer(braveApiKey) },
    };
    allowedTools.push("mcp__brave__brave_web_search", "mcp__brave__brave_image_search");
  }
  // User-attached course MCP servers (already approved in settings).
  for (const s of customServers) {
    options.mcpServers = {
      ...(options.mcpServers || {}),
      [s.id]: {
        type: "stdio",
        command: s.command,
        args: Array.isArray(s.args) ? s.args : [],
        ...(s.env && Object.keys(s.env).length ? { env: s.env } : {}),
      },
    };
    if (Array.isArray(s.tools) && s.tools.length) {
      allowedTools.push(...s.tools.map((t) => `mcp__${s.id}__${t}`));
    } else {
      // No probed tool list — allow the whole server by prefix.
      allowedTools.push(`mcp__${s.id}`);
    }
  }
  if (readDirs.length) {
    // Live space directories the agent may explore — READ-ONLY. Grant only the
    // read tools and hard-deny every write/exec tool so the user's files (e.g. a
    // code repo) can never be modified, created, or deleted.
    allowedTools.push("Read", "Glob", "Grep", "LS");
    options.additionalDirectories = readDirs;
    options.cwd = readDirs[0];
    options.disallowedTools = [
      "Write",
      "Edit",
      "MultiEdit",
      "NotebookEdit",
      "Bash",
      "BashOutput",
      "KillShell",
    ];
  }
  if (allowedTools.length) options.allowedTools = allowedTools;
  // LEG-36: resume a prior session (same course) so its cached prefix is reused.
  if (resume) options.resume = resume;
  return options;
}

// LEG-36: reuse one Claude session per course across the wizard questions and
// the structure build so the shared topic prefix is prompt-cached. Keyed by
// opts.reuseKey (=courseId); the structure stage evicts on success and any
// failed call evicts so the next attempt starts clean. In-memory only.
const resumeSessions = new Map();
export function evictReuseSession(key) {
  if (key) resumeSessions.delete(key);
}

async function runStreamed(prompt, onProgress, opts) {
  let text = "";
  const modelConfig = await resolveModelConfig(opts?.modelConfig);
  const reuseKey = opts?.reuseKey;
  const priorSession = reuseKey ? resumeSessions.get(reuseKey) : undefined;
  // With web/Brave tools the agent may take several turns (search, read,
  // write); buildClaudeOptions picks the turn budget from the enabled tools.
  const options = buildClaudeOptions({
    maxTurns: opts?.maxTurns,
    web: opts?.web,
    braveApiKey: opts?.braveApiKey,
    modelConfig,
    dirs: opts?.dirs,
    category: opts?.category,
    stage: opts?.stage,
    customMcp: opts?.customMcp,
    resume: priorSession,
  });
  const rec = devlog.startCall({ backend: "claude", prompt, model: modelConfig?.model });
  try {
  for await (const message of query({ prompt, options })) {
    if (message.type === "assistant") {
      const content = message.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === "thinking") {
            // Full reasoning text — feeds the live transcript bubbles + dev log.
            const think = (block.thinking || "").trim();
            if (think) {
              rec.reasoning(think);
              if (onProgress) onProgress({ label: "thinking", detail: think });
            }
          } else if (block?.type === "text" && block.text) {
            // The final text is structured JSON for most stages — keep it a
            // short indicator rather than the whole payload.
            const tail = block.text.replace(/\s+/g, " ").trim().slice(-80);
            if (tail && onProgress) onProgress({ label: "writing", detail: tail });
          } else if (block?.type === "tool_use" && block.name) {
            // Surface what the tool is actually doing so the UI shows live
            // progress (a query or a URL) instead of a static tool name.
            const input = block.input || {};
            const name = block.name;
            let label, detail;
            if (name.includes("image")) {
              label = "searching images";
              detail = typeof input.query === "string" ? input.query : "";
            } else if (/fetch/i.test(name)) {
              label = "reading";
              detail = typeof input.url === "string" ? input.url : "";
            } else {
              label = "searching";
              detail =
                typeof input.query === "string"
                  ? input.query
                  : typeof input.title === "string"
                    ? input.title
                    : typeof input.libraryName === "string"
                      ? input.libraryName
                      : typeof input.libraryId === "string"
                        ? input.libraryId
                        : "";
            }
            rec.tool(`${label} (${name})`, detail);
            if (onProgress) onProgress({ label, detail: detail || name });
          }
        }
      }
    } else if (message.type === "result" && message.subtype === "success") {
      text = message.result;
      // LEG-36: remember this session id so the next call in the topic resumes it.
      if (reuseKey && message.session_id) resumeSessions.set(reuseKey, message.session_id);
    }
  }
  } catch (e) {
    evictReuseSession(reuseKey);
    rec.error(e);
    throw e;
  }
  rec.end(text);
  return text;
}

// Pull the first JSON object out of an LLM reply that may contain prose,
// markdown fences, or trailing junk.
function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [];
  if (fence) candidates.push(fence[1].trim());
  const brace = text.match(/\{[\s\S]*\}/);
  if (brace) candidates.push(brace[0]);
  candidates.push(text.trim());
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {}
  }
  throw new Error("response did not contain valid JSON: " + text.slice(0, 200));
}

// Real model list from the Claude CLI (cached — it spawns the CLI). Each entry
// carries the effort levels that specific model actually supports.
let _modelsCache = null;
export async function listModels() {
  if (_modelsCache) return { models: _modelsCache };
  const q = query({ prompt: "list models", options: { maxTurns: 1, ...claudeBaseOptions() } });
  try {
    const models = await q.supportedModels();
    _modelsCache = (models || []).map((m) => ({
      value: m.value,
      label: m.displayName || m.value,
      description: m.description || "",
      effortLevels: Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels : [],
    }));
  } finally {
    try {
      await q.interrupt?.();
    } catch {}
  }
  return { models: _modelsCache };
}

// preferCheap: utility-bucket calls with no explicit model auto-pick the
// cheapest available (haiku family). Best-effort — any failure falls back to
// the agent's default model.
let _cheapModel; // undefined = unresolved, null = none found
async function resolveCheapModel() {
  if (_cheapModel !== undefined) return _cheapModel;
  try {
    const { models } = await listModels();
    _cheapModel =
      models.find((m) => m.value.toLowerCase().includes("haiku"))?.value ?? null;
  } catch {
    _cheapModel = null;
  }
  return _cheapModel;
}

/** Resolve modelConfig.preferCheap into a concrete cheap model when unset. */
async function resolveModelConfig(modelConfig) {
  if (!modelConfig?.preferCheap || modelConfig.model) return modelConfig;
  const cheap = await resolveCheapModel();
  return cheap ? { ...modelConfig, model: cheap } : modelConfig;
}

// Claude has no image generation; the dispatcher stays uniform via this stub.
export async function generateImage() {
  throw new Error("image generation is not supported by the claude agent");
}

/**
 * One-shot chat. Smoke-test method for M1.
 * @param {{ prompt: string }} params
 * @returns {Promise<{ text: string }>}
 */
export async function chat({ prompt }) {
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new Error("prompt must be a non-empty string");
  }
  const text = await runOnce(prompt);
  return { text };
}

function prevArticlesBlock(previousArticles, lang) {
  if (!previousArticles || previousArticles.length === 0) return "";
  const formatted = previousArticles
    .map((p) => `### ${p.moduleTitle} / ${p.submoduleTitle}\n${p.article}`)
    .join("\n\n---\n\n");
  return `The IMMEDIATELY PREVIOUS lesson, in full — match its tone, register,
and terminology; do NOT contradict it, do NOT repeat its content verbatim.
Earlier lessons are listed (titles) in the curriculum outline. Write in
language "${lang}" the same as it.

<previous-articles>
${formatted}
</previous-articles>

`;
}

/**
 * Stage 1 — draft a fresh article. Now also picks visual aids (image
 * placeholders and Mermaid diagrams) and embeds widget markers inline.
 * @returns {Promise<{ article: string, widgets: object }>}
 */
export async function submoduleDraft(params, ctx) {
  return await draftArticleInternal(params, ctx?.progress);
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
    genProfile,
    learnerProfile,
    researchPack,
    customMcp,
    factInput,
    userInstructions,
    docPagesContext,
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
  // Active-engagement: formative checkpoints, gated by pedagogy intensity.
  const intensity = genProfile?.pedagogyIntensity || "standard";
  // Per-domain teaching recipe (how to teach this category) — applies even in a
  // strict space, since it shapes pedagogy, not sources.
  const pedagogyBlock =
    categoryPedagogyBlock(category, lang, intensity) + learnerProfileBlock(learnerProfile);
  const checkpointGuide =
    intensity === "lean"
      ? "Do NOT add any checkpoint widgets."
      : `Active engagement: add ${intensity === "max" ? "3-4" : "2-3"} "checkpoint" widgets placed at natural points MID-article (right after a key idea, before stating the takeaway). Each must make the learner actively retrieve, predict, or self-explain — not just recall a definition — with a concise confirming "answer". They are optional/non-gating. Skip checkpoints only for purely narrative content.`;
  const memoryBlock =
    memoryFiles && memoryFiles.length
      ? `Past user feedback (apply to tone and content):\n${memoryFiles
          .map((f) => `--- ${f.filename} ---\n${f.content}`)
          .join("\n\n")}\n\n`
      : "";
  const hasPack = typeof researchPack === "string" && researchPack.trim().length > 0;
  const researchPackBlock = hasPack
    ? `<research-pack>
${researchPack.trim()}
</research-pack>
This pack was compiled and verified when the course was designed. Treat it as
pre-verified grounding: take canonical facts, terminology, key sources and the
misconception warnings from it — do NOT re-research them. Spend your (reduced)
web budget only on lesson-specific specifics the pack does not cover (exact
code APIs, image/video URLs, fine-grained numbers).

`
    : "";
  const researchBudgetLine = hasPack
    ? "Research efficiently: 1-2 targeted lookups for lesson-specific specifics (the research pack already covers the fundamentals),"
    : "Research efficiently: a few targeted lookups (about 3-4 web calls total),";
  const prompt = `You are writing one submodule of a personalized course on
"${topic}" (language: ${lang}).

${courseFormatGuide(courseFormat, lang)}
${podcastNoWidgetGuide(courseFormat)}
${factCheckInputBlock(courseFormat, factInput)}${userInstructionsBlock(userInstructions)}
Course brief (wizard Q&A):
<course-md>
${courseMd}
</course-md>

Full curriculum (for context — do not repeat other modules):
<structure>
${JSON.stringify(structure, null, 2)}
</structure>
${docPagesContextBlock(courseFormat, docPagesContext)}
${spaceContextBlock(spaceSources, spaceLinks, lang, spaceStrict, spaceDirs)}${categoryBlock}${pedagogyBlock}${researchPackBlock}${memoryBlock}${prevArticlesBlock(previousArticles, lang)}You are writing this specific submodule:
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

Math: write EVERY mathematical expression as LaTeX — inline as $…$, standalone
equations as $$…$$. This applies to even the simplest math: variables ($x$),
powers ($x^2$, never x² or a bare x^2), subscripts ($x_i$), fractions
($\\frac{a}{b}$, never a/b), roots ($\\sqrt{x}$), Greek letters ($\\pi$, $\\alpha$),
sums/integrals/limits, and comparison/operator symbols ($\\leq$, $\\geq$, $\\neq$,
$\\times$, $\\cdot$, $\\approx$). NEVER use Unicode math symbols (², ³, √, ≤, ≥, ≠,
×, ·, π, ∑, ∫, →, ∞) or plain-text math in prose. Keep every formula valid and
renderable by KaTeX: balanced $ delimiters and { } braces, standard commands,
and make sure the math is also CORRECT, not just well-formed.

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
  ::widget{type="interactive" id="int-1"}  (a parameterized interactive exercise — see the template catalog below)
  ::widget{type="checkpoint" id="cp-1"}    (a predict-then-reveal check — see below)

Use 1-6 widgets total when the topic has concrete visual references, counting
one gallery as one widget. Use 0 only when the topic is purely textual prose.
Do a silent paragraph-by-paragraph visual pass:
for each paragraph, decide whether an image, gallery, diagram, video, or
interactive widget would make the learner understand faster. Add visuals where
they are genuinely useful; don't decorate every paragraph.
Diagrams are great for processes, hierarchies, state machines, sequences,
component relations. Use Mermaid syntax (flowchart TD, sequenceDiagram, etc.).

IMAGE AND GALLERY WIDGETS — for each image item, set "mode":
  • "search" — a real, specific, existing thing that we should FIND, not invent:
    a named artwork by a known artist, a real person/place/object/event, a
    historical artifact, a museum hall, a map, a real diagram/plan, or a real
    software screenshot. Write "prompt" as a precise search target.
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
When only a SEGMENT of a video is relevant, set "start"/"end" (in seconds) and
"focus" (1-2 sentences: what exactly to watch for in that fragment). Never drop
an hour-long tutorial on the learner without timestamps when the relevant part
is shorter.

VISUAL/TOOL SUBJECTS — when this lesson teaches operating a SOFTWARE TOOL or a
visual workflow (3D/Blender, video editing, image editors, DAWs, CAD, any
software-driven craft):
- Video is the PRIMARY carrier: include 1-2 video widgets with verified,
  reasonably recent tutorials; the article is the structured companion (what to
  watch for, the exact procedure, pitfalls) — not a substitute for seeing it.
- UI screenshots: image widgets MUST use mode "search" (real screenshots of the
  actual interface; include the software name and version in the search prompt).
  NEVER use mode "generate" for software UI — generated interfaces show controls
  that don't exist and actively mislead.
- Every procedural step names the exact menu path and keyboard shortcut
  (e.g. Edit Mode → Ctrl+B → drag to set bevel width).
- Prefer the "steps" template for tool procedures.

${templateCatalogBlock(lang, category)}
${customMcpBlock(customMcp)}
You have live web access — use it:
- WebSearch — search the web to verify facts, find concrete examples,
  current best practices, citations, and useful YouTube/Vimeo videos. For
  videos, search things like "<topic> lecture youtube", "<topic> demo youtube",
  "best youtube videos to learn X reddit", "<topic> recommended video
  tutorials site:reddit.com", "<topic> syllabus video" — find videos with a
  quality signal, not whatever ranks first.
- WebFetch — open a specific URL and read the actual page before relying on
  it; don't cite a source you only saw as a search snippet.
- mcp__context7__resolve-library-id + mcp__context7__query-docs — for current
  library/framework/API/CLI/cloud-service documentation. Use these for
  programming and tool-specific course material instead of relying on memory.
- mcp__mediawiki__search-page / get-page / get-file — read-only access to
  Wikimedia Commons, English Wikipedia, and Russian Wikipedia. Use these for
  artworks, museum objects, public-domain media, encyclopedia pages, real maps,
  file metadata, and Commons image URLs before falling back to general search.
${
  braveApiKey
    ? `- mcp__brave__brave_image_search — find REAL image URLs for image
  and gallery widgets. When you find a good one, set "url" to the direct
  image URL and "source" to the page url. If nothing fits, leave url empty —
  the app will search again or show a placeholder/generate if mode permits.
`
    : `For image and gallery widgets, use WebSearch/WebFetch to find credible
  public source pages when the exact real image matters. Put the page URL in
  "source"; put "url" only if you are confident it is a direct real image URL.
  Source-only is useful: the app will extract og:image, srcset, JSON-LD, and
  large image assets from the page later.
`
}
${researchBudgetLine}
then STOP and write. Finishing the article matters more than exhaustive
research. Write in your own voice — don't quote large blocks; weave findings
in naturally. Only state a fact if you actually have a source backing it.

SOURCES: at the end, return a "sources" array listing every URL you
ACTUALLY consulted while writing this submodule. Be honest — do not
invent URLs, do not include sources you didn't read. If you wrote
entirely from your own knowledge with no web lookups, return [].

EDITOR PASS — before you return, re-read your draft and fix it as a careful
editor + fact-checker. Do this silently; return only the polished result:
1. Punctuation — fix errors.
2. Typography for "${lang}" — proper quotes («» in Russian, "" in English),
   em-dashes — where appropriate, no double spaces, proper ellipses (…),
   non-breaking spaces where idiomatic.
3. Factual claims — verify them (use web search). Fix
   what's wrong; if you cannot verify a load-bearing claim, soften it
   ("часто", "в большинстве случаев") or drop it.
4. Consistency — do not contradict the previous submodules above; use the
   same terminology and level assumptions.
5. Flow — light polish only; do NOT restructure or change the voice.
Put a 1-3 sentence log of what you changed in "notes" (empty string if nothing).

${languageStyleGuide(lang)}

Output ONLY a JSON object on a single line, no prose, no markdown fence:
{"article":"<markdown with widget markers>","widgets":[<widget objects>],"sources":[<source objects>],"notes":"<editor log>"}

Each widget object:
- image: {"id":"img-1","type":"image","mode":"search|generate","description":"<short UI caption in ${lang}>","prompt":"<internal search target or generation prompt in ${lang}>","alt":"<short alt in ${lang}>","url":"<direct image url or empty>","source":"<page url or empty>"}
- gallery: {"id":"gal-1","type":"gallery","caption":"<short caption in ${lang}>","items":[{"mode":"search|generate","description":"<short UI caption in ${lang}>","prompt":"<internal search target or generation prompt in ${lang}>","alt":"<short alt in ${lang}>","url":"<direct image url or empty>","source":"<page url or empty>"}]}
- diagram: {"id":"diag-1","type":"diagram","source":"<mermaid source>","caption":"<short caption in ${lang}>"}
- video: {"id":"vid-1","type":"video","url":"<youtube/vimeo watch url>","title":"<video title>","recommended_by":"<url of the recommendation source>","why":"<one-sentence reason in ${lang}>","start":<seconds, omit for whole video>,"end":<seconds, omit if open-ended>,"focus":"<what to watch for in the fragment, in ${lang}; omit if none>"}
- interactive: {"id":"int-1","type":"interactive","template":"<catalog name>","title":"<short label in ${lang}>","description":"<1-2 sentences in ${lang}>","params":{<template params per the catalog>}}
- checkpoint: {"id":"cp-1","type":"checkpoint","question":"<a predict / retrieve / self-explain prompt in ${lang}>","answer":"<concise confirming answer + why, in ${lang}>"}
${checkpointGuide}
Each source object: {"title":"<page title>","url":"<url>"}
If no widgets, use []. If no sources, use [].`;
  onProgress?.({ label: "thinking" });
  const text = await runStreamed(prompt, onProgress, {
    web: true,
    braveApiKey,
    modelConfig,
    dirs: spaceDirs,
    maxTurns: MAX_AGENT_TURNS,
    category,
    stage: "draft",
    customMcp,
  });
  const parsed = extractJson(text);
  if (!parsed?.article || typeof parsed.article !== "string") {
    throw new Error("LLM returned no article");
  }
  return {
    article: parsed.article.trim(),
    widgets: normalizeWidgets(parsed.widgets),
    sources: normalizeSources(parsed.sources),
    notes: typeof parsed.notes === "string" ? parsed.notes.trim() : "",
  };
}

function normalizeWidgets(raw) {
  const out = {};
  if (!Array.isArray(raw)) return out;
  for (const w of raw) {
    if (!w || typeof w.id !== "string" || !w.id.trim()) continue;
    const id = w.id.trim();
    if (w.type === "image") {
      const url = typeof w.url === "string" ? w.url.trim() : "";
      out[id] = {
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
    } else if (w.type === "gallery") {
      const items = Array.isArray(w.items)
        ? w.items
            .map((item) => {
              if (!item) return null;
              const url = typeof item.url === "string" ? item.url.trim() : "";
              return {
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
        out[id] = {
          type: "gallery",
          caption: typeof w.caption === "string" ? w.caption.trim() : "",
          items: items.slice(0, 6),
        };
      }
    } else if (w.type === "diagram") {
      out[id] = {
        type: "diagram",
        source: typeof w.source === "string" ? w.source.trim() : "",
        caption: typeof w.caption === "string" ? w.caption.trim() : "",
      };
    } else if (w.type === "video") {
      const url = typeof w.url === "string" ? w.url.trim() : "";
      if (!url) continue;
      const start = Number.isInteger(w.start) && w.start >= 0 ? w.start : null;
      const end = Number.isInteger(w.end) && w.end > (start ?? 0) ? w.end : null;
      out[id] = {
        type: "video",
        url,
        title: typeof w.title === "string" ? w.title.trim() : "",
        recommended_by:
          typeof w.recommended_by === "string" ? w.recommended_by.trim() : "",
        why: typeof w.why === "string" ? w.why.trim() : "",
        ...(start !== null ? { start } : {}),
        ...(end !== null ? { end } : {}),
        ...(typeof w.focus === "string" && w.focus.trim()
          ? { focus: w.focus.trim().slice(0, 300) }
          : {}),
      };
    } else if (w.type === "interactive") {
      // Template widgets only: invalid/free-form output is dropped (its
      // article marker is cleaned up by stripUnknownWidgetMarkers).
      const tw = normalizeTemplateWidget(w);
      if (tw) out[id] = tw;
    } else if (w.type === "checkpoint") {
      // Formative "predict then reveal" check embedded mid-article.
      const question = typeof w.question === "string" ? w.question.trim() : "";
      const answer = typeof w.answer === "string" ? w.answer.trim() : "";
      if (question && answer) {
        out[id] = { type: "checkpoint", question, answer };
      }
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

Output ONLY a JSON object on a single line, no prose, no markdown fence:
{"article":"<full article markdown with existing markers preserved and new markers inserted>","widgets":[<new image/gallery widget objects only>]}

Each new widget object:
- image: {"id":"img-auto-1","type":"image","mode":"search|generate","description":"<short UI caption in ${lang}>","prompt":"<internal search target or generation prompt in ${lang}>","alt":"<short alt in ${lang}>","url":"","source":""}
- gallery: {"id":"gal-auto-1","type":"gallery","caption":"<short caption in ${lang}>","items":[{"mode":"search|generate","description":"<short UI caption in ${lang}>","prompt":"<internal search target or generation prompt in ${lang}>","alt":"<short alt in ${lang}>","url":"","source":""}]}

If no new visual is useful, return the unchanged article and "widgets": [].`;
  ctx?.progress?.({ label: "marking", detail: "paragraph-by-paragraph visual pass" });
  const text = await runStreamed(prompt, ctx?.progress, {
    web: false,
    braveApiKey,
    modelConfig,
  });
  const parsed = extractJson(text);
  const additions = normalizeWidgets(parsed?.widgets);
  const merged = { ...existingWidgets };
  for (const [id, widget] of Object.entries(additions)) {
    if (!merged[id]) merged[id] = widget;
  }
  const plannedArticle =
    typeof parsed?.article === "string" && parsed.article.trim()
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

/** Stage 2 — editor + fact-check + consistency pass. */
export async function submoduleReview(params, ctx) {
  return await reviewArticle(params, ctx?.progress);
}

async function reviewArticle(
  { article, language, topic, previousArticles, modelConfig },
  onProgress
) {
  const lang = (language || "en").trim();
  const mathLint = lintMath(article);
  const mathFlag = mathLint.ok
    ? ""
    : ` A quick scan flagged possibly-malformed math to fix first: ${describeMathIssues(mathLint.issues)}.`;
  const prompt = `You are reviewing one submodule article from a course on
"${topic}" (language: ${lang}). Act as a careful editor + fact-checker.

Tasks, in order:
1. Punctuation — fix any errors.
2. Typography — proper quotes for the target language (e.g. «» in Russian,
   "" in English), em-dashes — where appropriate, no double spaces, proper
   ellipses (…), non-breaking spaces where idiomatic.
3. Factual claims — verify them. If something is wrong, fix it. If you cannot
   verify a specific claim and it carries weight, soften the language
   (e.g. "часто" / "в большинстве случаев") or remove the unsubstantiated bit.
4. Internal consistency — check this article against the previous submodules
   shown below. If there are contradictions (terminology, facts, level
   assumptions, etc.), resolve them in favor of what's already established.
5. Math — ensure EVERY mathematical expression is valid, correct LaTeX: inline
   $…$, display $$…$$. Convert any plain-text or Unicode math (x², √, ≤, a/b, →,
   π, …) to LaTeX, fix unbalanced $ delimiters or { } braces so it renders in
   KaTeX, and verify the math itself is correct, not merely well-formed.${mathFlag}
6. Light polish for flow — do NOT rewrite the voice or restructure.
7. Preserve every ::widget{...} marker line EXACTLY as-is — never remove, move,
   merge, reword, or translate them, and keep the blank lines around them.

${prevArticlesBlock(previousArticles, lang)}Article to review:
<article>
${article}
</article>

${languageStyleGuide(lang)}

Output ONLY a JSON object on a single line:
{"article":"<full revised article markdown>","notes":"<1-3 sentences describing what you fixed; empty string if nothing>"}`;
  onProgress?.({ label: "reviewing" });
  const text = await runStreamed(prompt, onProgress, { modelConfig });
  const parsed = extractJson(text);
  return {
    article:
      typeof parsed?.article === "string" && parsed.article.trim()
        ? parsed.article.trim()
        : article,
    notes: typeof parsed?.notes === "string" ? parsed.notes.trim() : "",
  };
}

/**
 * Stage 3 — validate widgets. Currently a fast JS-side Mermaid sanity
 * check; invalid diagrams get flagged so the UI can render an error
 * instead of a broken SVG. Same exported name (submoduleAnnotate) for
 * dispatcher back-compat — kept thin to allow future LLM-assisted fix.
 */
export async function submoduleAnnotate(params, ctx) {
  return await validateWidgets(params, ctx?.progress);
}

async function validateWidgets({ article, widgets, modelConfig }, onProgress) {
  onProgress?.({ label: "validating" });
  const out = {};
  let diagChecked = 0;
  let diagBad = 0;
  let intChecked = 0;
  let intRepaired = 0;
  let intBroken = 0;
  for (const [id, w] of Object.entries(widgets || {})) {
    if (w?.type === "diagram") {
      diagChecked++;
      const issue = mermaidIssue(w.source);
      if (issue) {
        diagBad++;
        out[id] = { ...w, error: issue };
        onProgress?.({ label: "validating", detail: `${id}: ${issue}` });
      } else {
        out[id] = w;
      }
    } else if (w?.type === "interactive" && w.template) {
      // Template widgets were schema-validated at draft time — pass through.
      // No jsdom, no Chrome render, no vision review, no repair loop.
      intChecked++;
      out[id] = w;
    } else if (w?.type === "interactive") {
      // Legacy free-form widget (regenerated old lessons): keep the full
      // validate/repair machinery for them.
      intChecked++;
      const { final, error, repairs } = await validateAndRepairInteractive(
        w,
        id,
        onProgress,
        modelConfig
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
  return { article, widgets: out, notes };
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

// Vision review of a rendered widget screenshot.
export async function reviewWidgetRender({ title, description, pngPath, modelConfig }, ctx) {
  let bytes;
  try {
    bytes = readFileSync(pngPath);
  } catch {
    return { ok: true, defects: [], summary: "render unavailable" };
  }
  const content = [
    { type: "text", text: widgetReviewPrompt(title, description) },
    {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: bytes.toString("base64") },
    },
  ];
  async function* userPrompt() {
    yield { type: "user", message: { role: "user", content }, parent_tool_use_id: null };
  }
  ctx?.progress?.({ label: "validating", detail: "visual check" });
  let text = "";
  for await (const m of query({
    prompt: userPrompt(),
    options: { maxTurns: 1, ...claudeBaseOptions(modelOptions(modelConfig)) },
  })) {
    if (m.type === "result" && m.subtype === "success") text = m.result;
  }
  return normalizeWidgetReview(extractJson(text));
}

// Render + vision-check one widget. Returns a defect string (only for CRITICAL
// render failures) to feed the repair loop, or null (skip/ok/minor). Self-
// disables when Chrome isn't available.
async function visualCheck(widget, id, modelConfig, onProgress) {
  if (!(await rendererAvailable())) return null;
  onProgress?.({ label: "validating", detail: `${id}: rendering` });
  const out = join(tmpdir(), `wv-${id}-${process.pid}-${Date.now()}.png`);
  const png = await renderWidgetPng(widget, out);
  if (!png) return null;
  try {
    const review = await reviewWidgetRender(
      { title: widget.title, description: widget.description, pngPath: png, modelConfig },
      { progress: onProgress }
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

async function validateAndRepairInteractive(widget, id, onProgress, modelConfig) {
  let current = widget;
  let lastError = await validateInteractive(current);
  if (!lastError) lastError = await visualCheck(current, id, modelConfig, onProgress);
  if (!lastError) return { final: current, error: null, repairs: 0 };

  onProgress?.({ label: "validating", detail: `${id}: ${lastError}` });

  for (let attempt = 1; attempt <= INTERACTIVE_MAX_REPAIRS; attempt++) {
    onProgress?.({
      label: "validating",
      detail: `${id}: repair ${attempt}/${INTERACTIVE_MAX_REPAIRS}`,
    });
    let repaired;
    try {
      repaired = await repairInteractive(current, lastError, modelConfig);
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
    if (!lastError) lastError = await visualCheck(current, id, modelConfig, onProgress);
    if (!lastError) return { final: current, error: null, repairs: attempt };
    onProgress?.({ label: "validating", detail: `${id}: ${lastError}` });
  }
  return { final: current, error: lastError, repairs: INTERACTIVE_MAX_REPAIRS };
}

async function repairInteractive(widget, errorMsg, modelConfig) {
  const prompt = repairPrompt(widget, errorMsg);
  const text = await runStreamed(prompt, undefined, { modelConfig });
  const parsed = extractJson(text);
  if (!parsed || typeof parsed !== "object") return null;
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

// First-line shape check. Catches the most common LLM mistake of writing
// prose instead of Mermaid, or using an unknown diagram type. Not a full
// parser — but cheap and catches >90% of garbage.
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

/**
 * Repair / edit one diagram or interactive widget on demand (the learner asked
 * to "fix it" or gave an instruction). Reuses the validate+repair pipeline.
 * @returns {Promise<{ widget: object }>} corrected content fields (+ error if any)
 */
export async function fixWidget({ language, topic, article, widget, instruction, modelConfig }, ctx) {
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
Return a corrected, VALID Mermaid diagram (labels in "${lang}").
Output ONLY a JSON object on a single line, no prose, no fence:
{"source":"<mermaid source>","caption":"<short caption or empty>"}`;
    const text = await runStreamed(prompt, ctx?.progress, { modelConfig });
    const parsed = extractJson(text) || {};
    const source =
      typeof parsed.source === "string" && parsed.source.trim() ? parsed.source.trim() : w.source;
    const out = { source, error: mermaidIssue(source) || null };
    if (typeof parsed.caption === "string" && parsed.caption.trim()) out.caption = parsed.caption.trim();
    return { widget: out };
  }
  if (type === "interactive" && w.template) {
    // Template widget: "fixing" = regenerating params against the catalog.
    const prompt = `You are fixing a parameterized interactive widget in a lesson on "${topic}" (language "${lang}").

${templateCatalogBlock(lang)}

The widget uses template "${w.template}". Current state:
{"title":${JSON.stringify(w.title || "")},"description":${JSON.stringify(w.description || "")},"params":${JSON.stringify(w.params ?? {})}}
${w.error ? `Known problem: ${w.error}\n` : ""}${instr ? `Learner's instruction: ${instr}\n` : ""}Lesson context (stay faithful to it):
<lesson>
${lessonCtx}
</lesson>
Return the corrected widget for the SAME template "${w.template}", obeying its
param shape and limits exactly. All learner-visible strings in "${lang}".
Output ONLY a JSON object on a single line, no prose, no fence:
{"title":"...","description":"...","params":{...}}`;
    const text = await runStreamed(prompt, ctx?.progress, { modelConfig });
    const parsed = extractJson(text) || {};
    const tw = normalizeTemplateWidget({ ...parsed, template: w.template });
    if (tw) {
      return {
        widget: {
          template: tw.template,
          title: tw.title,
          description: tw.description,
          params: tw.params,
          error: null,
        },
      };
    }
    return { widget: { error: "invalid template params" } };
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
${w.error ? `Known error: ${w.error}\n` : ""}Learner's instruction: ${instr}
Output ONLY a JSON object on a single line, no prose, no fence:
{"html":"...","css":"...","js":"...","height":<number optional>}`;
      const text = await runStreamed(prompt, ctx?.progress, { modelConfig });
      const parsed = extractJson(text);
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
    const { final, error } = await validateAndRepairInteractive(current, "fix", ctx?.progress, modelConfig);
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
 * Three-stage submodule pipeline: draft → review → annotate images.
 * Each stage is its own LLM call; the orchestrator returns the final article,
 * the widget map for placeholders, and the editor's notes.
 *
 * @param {{topic:string, language:string, courseMd:string, structure:object, memoryFiles:{filename:string,content:string}[], modulePath:{title:string,summary:string}, submodulePath:{title:string,summary:string}, previousArticles:{moduleTitle:string,submoduleTitle:string,article:string}[]}} params
 * @returns {Promise<{ article: string, widgets: object, review_notes: string }>}
 */
/**
 * Composite — kept for back-compat / smoke tests. Rust drives the three
 * stages individually so it can emit per-stage progress events.
 */
export async function generateSubmodule(params) {
  if (!params.modulePath?.title || !params.submodulePath?.title) {
    throw new Error("modulePath and submodulePath must include titles");
  }
  const drafted = await draftArticleInternal(params);
  const reviewed = await reviewArticle({ ...params, article: drafted.article });
  const validated = await validateWidgets({ article: reviewed.article, widgets: drafted.widgets });
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

Output ONLY JSON on a single line, no prose, no markdown fence:
{"reply":"...","modules":[{"title":"...","summary":"...","submodules":[{"title":"...","summary":"..."}]}]}

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

/**
 * Iterate on the curriculum based on user feedback. Returns either a clarifying
 * reply (modules: []) or a full revised tree with a rationale in reply.
 * @param {{topic:string, language:string, courseFormat?:string, courseMd:string, currentStructure:object, memoryFiles:{filename:string,content:string}[], chatHistory:{role:string,text:string}[], userMessage:string}} params
 * @returns {Promise<{reply:string, modules: Array<{title:string, summary:string, submodules:{title:string,summary:string}[]}>}>}
 */
export async function refineStructure(params, ctx) {
  if (typeof params?.userMessage !== "string" || !params.userMessage.trim()) {
    throw new Error("userMessage must be a non-empty string");
  }
  const prompt = buildRefinePrompt(params);
  const text = await runStreamed(prompt, ctx?.progress, { web: true, modelConfig: params.modelConfig });
  const parsed = extractJson(text);
  return normalizeRefineResponse(parsed);
}

/**
 * Build a curriculum tree from the course.md (topic + wizard answers).
 * @param {{ courseMd: string, topic: string, language: string, courseFormat?: string }} params
 * @returns {Promise<{ title: string, modules: Array<{ title: string, summary?: string, submodules: Array<{ title: string, summary?: string }> }> }>}
 */
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
  const inlineDocs = docs.filter((d) => !d.file);
  const refDocs = docs.filter((d) => d.file);
  if (refDocs.length) {
    out += `\nLarge source documents — provided as FILES in the attached read-only directory (their converted-markdown folder is the first local directory listed above). READ them with your file tools (Read/Grep) while you work; the excerpt is only a hint of what's inside. Do NOT limit yourself to the excerpts${strict ? " — for this strict course these files ARE the mandatory base material" : ""}:\n`;
    out +=
      refDocs
        .map(
          (d) =>
            `- [${d.kind || "document"}] "${String(d.title || "").replace(/"/g, "'")}" — file ${d.file} (${d.chars} chars), starts: ${String(d.excerpt || "").replace(/\s+/g, " ").trim()}…`
        )
        .join("\n") + "\n";
  }
  if (inlineDocs.length) {
    out += `\nSource documents (the authoritative material for this course):\n`;
    out += inlineDocs
      .map(
        (d, i) =>
          `\n<source ${i + 1} title="${String(d.title || "").replace(/"/g, "'")}" kind="${d.kind || "document"}">\n${d.content || ""}\n</source>`
      )
      .join("\n");
    out += "\n";
  }
  return out + "\n";
}

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
    genProfile,
    learnerProfile,
    customMcp,
    reuseThreadPerTopic,
    reuseSessionKey,
    cautious,
    videoHeavy,
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
${learnerProfileBlock(learnerProfile)}${contentGuidanceBlock(cautious, videoHeavy)}
Below is the course brief — a markdown file with the wizard Q&A.

<course-md>
${courseMd}
</course-md>
${spaceContextBlock(spaceSources, spaceLinks, lang, spaceStrict, spaceDirs)}
First generate a short display title for the whole course, written in language
"${lang}", with no quotes and no "course about/on" wrapper. ${
    courseFormat === "fact_check"
      ? `This is a FACT-CHECK: the title MUST clearly identify the SPECIFIC claim being examined so it is instantly recognizable (concise, e.g. "Вакцины и аутизм", "Миф: Великая стена видна из космоса") — NEVER a generic label like "проверка гипотезы", "проверка факта" or "fact check".`
      : `It must NOT copy the learner's raw request verbatim; make it a concise noun phrase, 2-6 words.`
  }

Then design a curriculum: a list of top-level modules, each with a few submodules.

Research first. You have live web access (WebSearch + WebFetch) plus read-only
Context7 and Wikimedia/MediaWiki MCP tools — actually use the right source, but
keep it focused (a few targeted lookups are enough; don't
over-research). Before sketching anything, look up how this subject is taught
in serious places: university programs (especially the best ones —
top art academies, top engineering schools, etc. as relevant), well-regarded
online courses, established certifications, and the canonical reading paths
practitioners recommend. For programming/framework/API topics, use Context7 for
current docs. For art/history/museum subjects and public-domain media, use
MediaWiki/Wikimedia where relevant. Use the convergence of those programs as
your skeleton.
If multiple traditions exist (e.g. русская академическая vs European atelier),
acknowledge them and pick the one that best fits the learner's goals from the
brief. Never improvise a structure from intuition when established programs
exist.

Constraints:
- Reflect the learner's specific goals, prior knowledge, and constraints from the brief.
- Skip modules irrelevant to those goals; do not produce a generic textbook outline.
- Size the curriculum to the learner's time budget — fewer, denser submodules for small budgets.
- If the brief has a "## Diagnostic" section, honor it: compress what is already solid, scaffold what is weak.
- Follow the chosen generation format exactly for module/submodule counts and tone.
- All titles and summaries in language "${lang}".
- For NON-LINEAR subjects, if a submodule genuinely requires understanding an EARLIER submodule first, list those earlier submodule titles verbatim in its "prereqs" array. For linear/sequential courses where each part simply follows the previous, use an empty "prereqs" array. Never list a later submodule and never create cycles.

${languageStyleGuide(lang)}

Also classify this course into exactly ONE category id from this fixed list
(pick the single best fit; use "general" only when nothing else clearly fits):
${categoryClassifyGuide()}

RESEARCH PACK: after the curriculum, compile a markdown "researchPack" for the
lesson writers, in language "${lang}", from what you ACTUALLY found while
researching${spaceStrict ? " (built ONLY from the attached space material)" : ""}:
## Course-wide
- canonical definitions & terminology every lesson must use consistently;
- canonical facts (numbers, dates, names, formulas) lessons will rely on;
- common misconceptions to avoid (misconception → correction).
Then one "## <module title>" section per module:
- 3-6 key sources with URLs you actually consulted or verified exist (NEVER invent URLs);
- module-specific facts/terminology;
- 2-4 recommended search queries for the lesson writer.
Keep the whole pack under ~2500 words — it is injected into every lesson prompt
as pre-verified grounding.

${customMcpBlock(customMcp)}
Output ONLY a JSON object on a single line, no prose, no markdown fence.
Shape:
{"category":"<one id from the list above>","title":"...","researchPack":"<markdown>","modules":[{"title":"...","summary":"...","submodules":[{"title":"...","summary":"...","prereqs":[]}]}]}`;
  const text = await runStreamed(prompt, ctx?.progress, {
    web: true,
    modelConfig,
    dirs: spaceDirs,
    maxTurns: MAX_AGENT_TURNS,
    stage: "structure",
    customMcp,
    // LEG-36: continue the wizard's session so the topic prefix stays cached.
    reuseKey: reuseThreadPerTopic ? reuseSessionKey : undefined,
  });
  const parsed = extractJson(text);
  if (!Array.isArray(parsed?.modules) || parsed.modules.length === 0) {
    throw new Error("LLM response missing non-empty 'modules' array");
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
  // LEG-36: structure is the last stage of the reused topic session — release it.
  if (reuseThreadPerTopic) evictReuseSession(reuseSessionKey);
  return {
    title: normalizeCourseTitle(parsed?.title),
    modules,
    category: normalizeCategory(parsed?.category),
    researchPack:
      typeof parsed?.researchPack === "string" ? parsed.researchPack.trim() : "",
  };
}

/**
 * Assess a topic on two INDEPENDENT axes before building a curriculum:
 *   - safety: refuse a genuinely harmful topic, or flag a sensitive one for
 *     cautious, responsible treatment;
 *   - medium (a positive content hint, NOT a restriction): flag watch-first
 *     subjects (memes, demos, cooking, UI walkthroughs) so lessons lean on video.
 * The two are reported separately and never gate each other. Best-effort: a
 * missing/invalid result is treated as "ok" with no flags.
 * @returns {Promise<{ decision: "ok"|"caution"|"refuse", reason: string, video_heavy: boolean }>}
 */
export async function classifyTopic({ topic, language, courseMd, modelConfig }, ctx) {
  const lang = (language || "en").trim();
  const brief =
    typeof courseMd === "string" && courseMd.trim() ? `\nBrief:\n${courseMd.slice(0, 2000)}\n` : "";
  const prompt = `You are the safety + content gate for an educational course generator. Classify the topic below. Write any human-readable "reason" in language "${lang}".

Topic: ${JSON.stringify(topic)}${brief}

Pick exactly one "decision":
- "refuse" — refuse generation ENTIRELY when the topic's realistic purpose is socially harmful or dangerous (how to make weapons / explosives / poisons / illegal drugs, attacking people or infrastructure, malware or intrusion meant to cause harm), promotes or facilitates self-harm or SUICIDE, or is pornographic / sexually explicit material. When genuinely in doubt about real-world harm, REFUSE. Put a short, respectful explanation in "reason".
- "caution" — ALLOW but require careful, responsible treatment of a legitimate yet sensitive or potentially dangerous subject (medicine, mental health, self-defense, defensive security, hazardous chemistry/electricity, weapons as history, drugs/addiction, extremism studied as a subject). The course must stay strictly educational, add safety caveats, and never give operational harm-enabling detail.
- "ok" — everything else.

Separately, set "video_heavy": true when the subject is learned mainly by WATCHING and is easier to find on YouTube — internet memes and viral moments, dances or sports moves, music / instrument technique, cooking, crafts / DIY, makeup, software UI walkthroughs — so the course should lean on video. This is an INDEPENDENT, positive content hint, unrelated to the safety decision: set it whenever it fits, including for an "ok" or "caution" topic. It never restricts anything.

Output ONLY one line of JSON: {"decision":"ok|caution|refuse","reason":"...","video_heavy":true|false}`;
  ctx?.progress?.({ label: "checking topic" });
  const text = await runStreamed(prompt, ctx?.progress, { modelConfig });
  const parsed = extractJson(text);
  const decision =
    parsed?.decision === "refuse" || parsed?.decision === "caution" ? parsed.decision : "ok";
  return {
    decision,
    reason: typeof parsed?.reason === "string" ? parsed.reason.trim() : "",
    video_heavy: !!parsed?.video_heavy,
  };
}

/**
 * Design a learning roadmap for a goal: vertical stages of node cards, each
 * with curated sources and a set of checkable skills. Skills later become
 * lessons or courses, so they must be sized accordingly.
 * @param {{ topic:string, language:string, wizardMd:string, modelConfig?:object }} params
 * @returns {Promise<{title:string, stages:Array}>}
 */
export async function buildRoadmap({ topic, language, wizardMd, modelConfig }, ctx) {
  if (typeof topic !== "string" || !topic.trim()) {
    throw new Error("topic must be a non-empty string");
  }
  const lang = (language || "en").trim();
  const prompt = `You are designing a personalized LEARNING ROADMAP for the goal "${topic}" (language code "${lang}").

Below is the brief — the goal plus a short clarifying interview with the learner.

<roadmap-md>
${typeof wizardMd === "string" ? wizardMd : ""}
</roadmap-md>

A roadmap is a vertical sequence of STAGES (top to bottom, each builds on the
previous). Each stage contains 1-4 NODES — thematic cards. Each node has:
- "summary": 1-2 sentences on what this node covers and why it matters for the goal;
- "skills": 2-6 concrete, checkable skills (verb phrases — what the learner will
  be able to DO). Each skill will later become a standalone lesson or a
  mini-course, so size each one accordingly: not "знать всё о X", but a
  teachable, assessable unit.
- "sources": 2-5 curated links — official docs, well-known articles, books,
  videos, or courses.

Research first. You have live web access (WebSearch + WebFetch) — check how
respected roadmaps and tracks (roadmap.sh, university programs, well-known
guides) structure this path, and verify that every source URL you include
actually exists and is the canonical address. NEVER invent URLs; if you cannot
verify a link, leave it out.

Constraints:
- 3-7 stages total, ordered from the learner's CURRENT level (from the brief) to
  the goal — skip stages the learner already masters.
- Each stage: 1-4 nodes; each node: 2-6 skills, 2-5 sources.
- Source "kind" is exactly one of: "docs" | "article" | "video" | "course" | "book".
- All titles, summaries, and skills in language "${lang}". Source titles may stay
  in their original language.

${languageStyleGuide(lang)}

Also generate a short display "title" for the roadmap: a concise noun phrase,
2-6 words, in language "${lang}", no quotes.

Output ONLY a JSON object on a single line, no prose, no markdown fence.
Shape:
{"title":"...","stages":[{"title":"...","summary":"...","nodes":[{"title":"...","summary":"...","sources":[{"title":"...","url":"https://...","kind":"docs"}],"skills":[{"title":"...","desc":"..."}]}]}]}`;
  const text = await runStreamed(prompt, ctx?.progress, {
    web: true,
    modelConfig,
    stage: "structure",
    // Roadmap research (existing roadmaps + URL verification) is turn-hungry
    // and has no generation profile to size it.
    maxTurns: MAX_AGENT_TURNS,
  });
  const parsed = extractJson(text);
  if (!Array.isArray(parsed?.stages) || parsed.stages.length === 0) {
    throw new Error("LLM response missing non-empty 'stages' array");
  }
  const stages = parsed.stages
    .filter((s) => s && typeof s.title === "string" && s.title.trim())
    .slice(0, 7)
    .map((s) => ({
      title: s.title.trim(),
      summary: typeof s.summary === "string" ? s.summary.trim() : "",
      nodes: (Array.isArray(s.nodes) ? s.nodes : [])
        .filter((n) => n && typeof n.title === "string" && n.title.trim())
        .slice(0, 4)
        .map((n) => ({
          title: n.title.trim(),
          summary: typeof n.summary === "string" ? n.summary.trim() : "",
          sources: (Array.isArray(n.sources) ? n.sources : [])
            .filter(
              (src) =>
                src &&
                typeof src.title === "string" &&
                src.title.trim() &&
                typeof src.url === "string" &&
                src.url.trim().startsWith("http")
            )
            .slice(0, 5)
            .map((src) => ({
              title: src.title.trim(),
              url: src.url.trim(),
              kind: typeof src.kind === "string" ? src.kind.trim() : "",
            })),
          skills: (Array.isArray(n.skills) ? n.skills : [])
            .filter((sk) => sk && typeof sk.title === "string" && sk.title.trim())
            .slice(0, 6)
            .map((sk) => ({
              title: sk.title.trim(),
              desc: typeof sk.desc === "string" ? sk.desc.trim() : "",
            })),
        }))
        .filter((n) => n.skills.length > 0),
    }))
    .filter((s) => s.nodes.length > 0);
  if (stages.length === 0) {
    throw new Error("response had no usable stages");
  }
  return { title: normalizeCourseTitle(parsed?.title), stages };
}

function normalizeGeneratedTags(raw) {
  const seen = new Set();
  const tags = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const tag = String(item || "")
      .split(/\s+/)
      .filter(Boolean)
      .join(" ")
      .replace(/^[#,\s;]+|[#,\s;]+$/g, "")
      .trim();
    if (tag.length < 2 || tag.length > 36) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length >= 8) break;
  }
  return tags;
}

export async function generateTags({ kind, topic, title, language, courseFormat, structure, roadmap, modelConfig }) {
  const lang = (language || "en").trim();
  const itemKind = String(kind || "course");
  const context = JSON.stringify(
    {
      kind: itemKind,
      topic,
      title,
      language: lang,
      courseFormat,
      structure,
      roadmap,
    },
    null,
    2
  ).slice(0, 12000);
  const prompt = `Generate clean search/display tags for this learning ${itemKind}.
Language code: "${lang}".

Rules:
- Return 3-8 tags.
- Each tag is 1-3 words, specific, and useful for catalog search.
- Prefer the content language; keep standard English technical terms when natural.
- Do not include generic tags like course, lesson, roadmap, study, education, learning.
- No hashtags, punctuation wrappers, sentences, or duplicates.

Context JSON:
${context}

Output ONLY JSON:
{"tags":["..."]}`;
  const text = await runOnce(prompt, { modelConfig });
  const parsed = extractJson(text) || {};
  return { tags: normalizeGeneratedTags(parsed?.tags) };
}

// Shared validation for discover_mcp results in both agents.
export function normalizeMcpCandidates(parsed) {
  const candidates = (Array.isArray(parsed?.candidates) ? parsed.candidates : [])
    .filter(
      (c) =>
        c &&
        typeof c.name === "string" &&
        c.name.trim() &&
        typeof c.command === "string" &&
        c.command.trim() &&
        typeof c.sourceUrl === "string" &&
        c.sourceUrl.trim().startsWith("http")
    )
    .slice(0, 4)
    .map((c) => ({
      name: c.name.trim().slice(0, 80),
      description: typeof c.description === "string" ? c.description.trim().slice(0, 300) : "",
      command: c.command.trim(),
      args: (Array.isArray(c.args) ? c.args : [])
        .filter((a) => typeof a === "string" && a.trim())
        .map((a) => a.trim()),
      envKeys: (Array.isArray(c.envKeys) ? c.envKeys : [])
        .filter((k) => typeof k === "string" && k.trim())
        .map((k) => k.trim()),
      sourceUrl: c.sourceUrl.trim(),
    }));
  return { candidates };
}

/**
 * Web-research MCP servers that could enrich a course on this topic
 * (e.g. blender-mcp for a Blender course). Only npx/stdio-runnable servers.
 * @param {{topic:string, language:string, modelConfig?:object}} params
 * @returns {Promise<{candidates: Array<{name, description, command, args, envKeys, sourceUrl}>}>}
 */
export async function discoverMcp({ topic, language, modelConfig }, ctx) {
  if (typeof topic !== "string" || !topic.trim()) {
    throw new Error("topic must be a non-empty string");
  }
  const lang = (language || "en").trim();
  const prompt = `Find MCP (Model Context Protocol) servers that could ENRICH the
generation of a learning course on "${topic}" — tools the writing agent could
call for live, domain-specific data or control of the actual software being
taught (e.g. blender-mcp for a Blender course, a chess-engine MCP for chess).

Research with web search: check the official registry/lists
(github.com/modelcontextprotocol/servers, mcpservers.org, npm search
"mcp <topic>"), the tool's own ecosystem, and GitHub. Verify each candidate's
page actually exists and describes an MCP server.

HARD RULES:
- Only servers runnable as a LOCAL stdio process with a simple command — prefer
  "npx" with args ["-y","<npm-package>"]; a documented "uvx <pkg>" is also
  acceptable. Skip anything needing cloning/building or a remote URL transport.
- Skip servers that require heavy external setup UNLESS that setup is exactly
  the software being taught (a Blender MCP needing a running Blender is fine
  for a Blender course).
- List required environment variables (API keys) in "envKeys" — empty if none.
- "sourceUrl" is the real GitHub/npm page you verified. NEVER invent packages.
- 0-4 candidates; an empty list is a perfectly good answer for most topics
  (history, language learning, ...). Recommend only genuinely useful servers.
- "description": 1-2 sentences in language "${lang}" — what the tools give the
  course generator, plus any setup caveat.

Keep the research focused: a handful of registry/npm/GitHub lookups, verify the
finalists, then answer — do not exhaustively browse.

Output ONLY a JSON object on a single line:
{"candidates":[{"name":"...","description":"...","command":"npx","args":["-y","pkg"],"envKeys":[],"sourceUrl":"https://..."}]}`;
  ctx?.progress?.({ label: "searching" });
  // Registry + npm + GitHub verification needs real turn budget.
  const text = await runStreamed(prompt, ctx?.progress, {
    web: true,
    modelConfig,
    maxTurns: MAX_AGENT_TURNS,
  });
  return normalizeMcpCandidates(extractJson(text));
}

// Shared by both quiz/refine roadmap helpers: clamp + validate quiz questions.
function normalizeNodeQuiz(parsed, skillIds) {
  const valid = new Set(skillIds);
  const questions = (Array.isArray(parsed?.questions) ? parsed.questions : [])
    .filter(
      (q) =>
        q &&
        typeof q.text === "string" &&
        q.text.trim() &&
        valid.has(q.skillId) &&
        Array.isArray(q.options) &&
        q.options.filter((o) => typeof o === "string" && o.trim()).length >= 2 &&
        Number.isInteger(q.correct) &&
        q.correct >= 0 &&
        q.correct < q.options.length
    )
    .slice(0, 12)
    .map((q) => ({
      skillId: q.skillId,
      text: q.text.trim(),
      options: q.options.map((o) => String(o).trim()),
      correct: q.correct,
      explanation: typeof q.explanation === "string" ? q.explanation.trim() : "",
    }));
  return { questions };
}

/**
 * Diagnostic mini-quiz for one roadmap node: 1-2 questions per skill so the
 * learner can prove they already know it (correct answers auto-close skills).
 * @param {{topic:string, language:string, node:{title,summary,skills:[{id,title,desc}]}, modelConfig?:object}} params
 */
export async function roadmapNodeQuiz({ topic, language, node, modelConfig }, ctx) {
  const lang = (language || "en").trim();
  const skills = Array.isArray(node?.skills) ? node.skills : [];
  if (!skills.length) return { questions: [] };
  const prompt = `You are writing a short DIAGNOSTIC quiz for one node of a learning
roadmap on "${topic}" (language "${lang}"). The learner claims they may already
know this material — your questions decide which skills can be marked as known.

Node: ${node.title}${node.summary ? ` — ${node.summary}` : ""}
Skills (each question must target exactly ONE of these by its "skillId"):
${skills.map((s) => `- id "${s.id}": ${s.title}${s.desc ? ` — ${s.desc}` : ""}`).join("\n")}

Write 1-2 multiple-choice questions PER SKILL (max 12 total). Questions must be
practical and discriminative: someone who truly has the skill answers easily,
someone who doesn't will fail. 2-4 plausible options each, exactly one correct.
All text in language "${lang}".

${languageStyleGuide(lang)}

Output ONLY a JSON object on a single line:
{"questions":[{"skillId":"...","text":"...","options":["..."],"correct":0,"explanation":"..."}]}`;
  ctx?.progress?.({ label: "thinking" });
  const text = await runStreamed(prompt, ctx?.progress, { modelConfig });
  return normalizeNodeQuiz(extractJson(text), skills.map((s) => s.id));
}

/**
 * Conversational refinement of a roadmap: returns a reply and, when the user
 * asked for changes, a full replacement content proposal. Item ids must be
 * PRESERVED for kept stages/nodes/skills (course links and done-marks hang on
 * them); new items come without ids.
 * @param {{topic:string, language:string, currentContent:object, chatHistory?:Array, userMessage:string, modelConfig?:object}} params
 */
export async function refineRoadmap(
  { topic, language, currentContent, chatHistory, userMessage, modelConfig },
  ctx
) {
  if (typeof userMessage !== "string" || !userMessage.trim()) {
    throw new Error("userMessage must be a non-empty string");
  }
  const lang = (language || "en").trim();
  const hist =
    Array.isArray(chatHistory) && chatHistory.length
      ? `Conversation so far:\n${chatHistory
          .map((m) => `${m.role === "agent" ? "Assistant" : "Learner"}: ${m.text}`)
          .join("\n")}\n\n`
      : "";
  const prompt = `You are refining a LEARNING ROADMAP for the goal "${topic}" (language "${lang}")
in a dialog with the learner.

Current roadmap (JSON, including item ids):
${JSON.stringify(currentContent ?? {})}

${hist}Learner's new message:
${userMessage.trim()}

If the message asks for CHANGES, produce the FULL updated roadmap in "content".
CRITICAL ID RULES:
- Every stage/node/skill you KEEP must keep its exact "id" from the current
  JSON (course links and done-marks are attached to those ids).
- New items you add must have NO "id" field.
- Removing items is allowed when asked.
Respect the shape: stages[{id?,title,summary,nodes[{id?,title,summary,sources[{title,url,kind}],skills[{id?,title,desc}]}]}],
caps 3-7 stages / 1-4 nodes / 2-6 skills / 2-5 sources, kinds docs|article|video|course|book,
verified real URLs only (web access available — check anything you add).
If the message is just a question, answer it and set "content": null.
"reply": 1-3 sentences in "${lang}" describing what you changed (or the answer).

${languageStyleGuide(lang)}

Output ONLY a JSON object on a single line:
{"reply":"...","content":{...}|null}`;
  ctx?.progress?.({ label: "refining" });
  const text = await runStreamed(prompt, ctx?.progress, {
    web: true,
    modelConfig,
    maxTurns: MAX_AGENT_TURNS,
  });
  const parsed = extractJson(text);
  const reply =
    typeof parsed?.reply === "string" && parsed.reply.trim()
      ? parsed.reply.trim()
      : "";
  if (!reply) throw new Error("refine response missing 'reply'");
  const content =
    parsed?.content && Array.isArray(parsed.content.stages) ? parsed.content : null;
  return { reply, content };
}

/**
 * Generate clarifying questions for a course topic, in the course's language.
 * Each question has a small set of realistic answer options.
 * @param {{ topic: string, language: string }} params
 * @returns {Promise<{ title: string, questions: Array<{ text: string, options: string[] }> }>}
 */
/**
 * Generate a multiple-choice test for a submodule, based on its article.
 * @param {{topic:string, language:string, submodulePath:{title:string,summary:string}, article:string}} params
 * @returns {Promise<{questions: Array<{text:string, options:string[], correct:number, explanation:string}>}>}
 */
export async function translateStrings({ sourceLang, targetLang, strings, modelConfig }) {
  const arr = Array.isArray(strings) ? strings : [];
  if (!arr.length) return { translations: [] };
  const prompt = `Translate each element of this JSON array of strings from language "${sourceLang || "auto"}" into language "${targetLang}".
- Keep meaning and tone; use idiomatic, professional target-language terminology.
- Do NOT translate code, identifiers, file paths, URLs, numbers, or {placeholders} — keep them verbatim.
- Preserve order and array length exactly.
Return ONLY a JSON object {"translations": ["...", ...]} with the translated strings in the same order, no prose.

${JSON.stringify(arr)}`;
  const text = await runOnce(prompt, { modelConfig });
  const parsed = extractJson(text);
  const out = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.translations)
      ? parsed.translations
      : [];
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
  const text = await runOnce(prompt, { modelConfig });
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
  const text = await runOnce(prompt, { modelConfig });
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
  const text = await runOnce(prompt, { modelConfig });
  const parsed = extractJson(text);
  return {
    html: typeof parsed?.html === "string" ? parsed.html : html || "",
    css: typeof parsed?.css === "string" ? parsed.css : css || "",
    js: typeof parsed?.js === "string" ? parsed.js : js || "",
  };
}

// AI assistant: answer a learner's question grounded in the course program,
// the current lesson, an optionally-quoted fragment, and the space sources.
// Render a compact context block for a widget the learner targeted ("✦ Ask"),
// so the assistant can answer / fix / critique that specific widget.
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
    learnerProfile,
    socratic,
    exercise,
    exchangeCount,
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
  const opening = socratic
    ? socraticBlock(topic, lang, exercise, exchangeCount)
    : `You are a knowledgeable, friendly tutor for a learner taking a course on "${topic}". Answer the learner's question in language "${lang}".
Ground your answer in the COURSE PROGRAM and the lesson material below; prefer the course's own framing and terminology. If the question is outside the course's scope, say so briefly and still help where you can.`;
  const prompt = `${opening}
${learnerProfileBlock(learnerProfile)}${spaceContextBlock(spaceSources, spaceLinks, lang, spaceStrict, spaceDirs)}
Course program (curriculum):
<structure>
${JSON.stringify(structure ?? {}, null, 2)}
</structure>

${articleBlock}${fragBlock}${widgetBlock}${histBlock}Learner's question: ${question}

Answer in ${lang}, in Markdown. Be concise but complete; use examples or code where they help.`;

  // Attached image → vision: include it in the message and analyze it.
  let imgBytes = null;
  if (imagePath) {
    try {
      imgBytes = readFileSync(imagePath);
    } catch {
      imgBytes = null;
    }
  }
  if (imgBytes) {
    const content = [
      {
        type: "text",
        text: `${prompt}\n\nThe learner attached an image — examine it carefully and ground your answer in what it actually shows (e.g. judge whether something is drawn/done correctly).`,
      },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: guessImageMime(imagePath),
          data: imgBytes.toString("base64"),
        },
      },
    ];
    async function* userPrompt() {
      yield { type: "user", message: { role: "user", content }, parent_tool_use_id: null };
    }
    ctx?.progress?.({ label: "thinking" });
    let text = "";
    // Grant the same tools as the text path (web + reference MCP + read-only
    // space dirs) so an image question is grounded identically across backends.
    for await (const m of query({
      prompt: userPrompt(),
      options: buildClaudeOptions({ maxTurns: MAX_AGENT_TURNS, web: true, modelConfig, dirs: spaceDirs }),
    })) {
      if (m.type === "result" && m.subtype === "success") text = m.result;
    }
    return { answer: (text || "").trim() };
  }

  const text = await runStreamed(prompt, ctx?.progress, {
    web: true,
    modelConfig,
    dirs: spaceDirs,
  });
  return { answer: (text || "").trim() };
}

/**
 * Deepen a lesson: write an additional Markdown "##" block. When the learner
 * targets a specific part, also return `anchor` — a verbatim line from the
 * lesson after which the new block should be spliced in place (the Rust side
 * does the splice and falls back to appending if the anchor is not found).
 * Returns { markdown, anchor }.
 */
export async function extendArticle(
  { language, topic, article, instruction, spaceSources, spaceLinks, spaceDirs, spaceStrict, modelConfig },
  ctx
) {
  const lang = (language || "en").trim();
  const instr = (instruction || "").trim();
  const prompt = `You are DEEPENING an existing lesson on "${topic}" (language "${lang}").
${spaceContextBlock(spaceSources, spaceLinks, lang, spaceStrict, spaceDirs)}
The lesson so far:
<lesson>
${article}
</lesson>

Write ONE focused ADDITIONAL block that goes beyond what is already covered${instr ? `. The learner asked specifically: "${instr}"` : " (edge cases, advanced techniques, worked examples, common pitfalls, deeper theory or context)"}.

Placement ("anchor"):
- If the request is about a SPECIFIC existing part of the lesson, set "anchor" to an EXACT, verbatim line copied from the lesson above (a "##"/"###" heading line, or the full first sentence of the relevant paragraph) AFTER which the new block belongs. Copy it character-for-character — do NOT paraphrase or shorten it.
- Otherwise (a general "go deeper"), set "anchor" to "" — the block will be appended at the end.

Rules for the new block ("markdown"):
- Begin with a Markdown "## " heading. Do NOT repeat anything already in the lesson; assume the learner has read it.
- Use prose and inline fenced code blocks where they help. Do NOT add any ::widget markers, images, or galleries.
- Write everything in language "${lang}".

${languageStyleGuide(lang)}

Output ONLY a single-line JSON object — no preamble, no surrounding code fence:
{"anchor":"<verbatim line from the lesson, or empty>","markdown":"<the new Markdown block>"}`;
  const text = await runStreamed(prompt, ctx?.progress, { web: true, modelConfig, dirs: spaceDirs });
  let parsed = null;
  try {
    parsed = extractJson(text);
  } catch {
    /* fall through to raw-text fallback below */
  }
  const markdown = (parsed?.markdown ?? "").toString().trim();
  if (!markdown) {
    // Model ignored the JSON contract — treat the whole reply as the block.
    return { markdown: (text || "").trim(), anchor: "" };
  }
  return { markdown, anchor: (parsed?.anchor ?? "").toString().trim() };
}

// Rewrite a selected text fragment per an instruction (the course editor's
// "edit selection with AI"). Returns ONLY the replacement markdown — the Rust
// side hands it back to the editor, which replaces the selection in place.
export async function editText({ language, topic, selection, instruction, context, modelConfig }, ctx) {
  const lang = (language || "en").trim();
  const sel = (selection ?? "").toString();
  const instr = (instruction || "").trim();
  if (!sel.trim() || !instr) return { text: sel };
  const ctxBlock = (context || "").toString().trim()
    ? `Surrounding lesson text (context only — do NOT rewrite or echo it):\n<context>\n${context}\n</context>\n\n`
    : "";
  const prompt = `You are editing a fragment of a lesson on "${topic}" (language "${lang}").
${ctxBlock}The learner selected EXACTLY this fragment:
<selection>
${sel}
</selection>

Apply this instruction to the selected fragment: ${instr}

Rules:
- Rewrite ONLY the selected fragment; your output replaces the selection verbatim.
- Preserve Markdown formatting and any LaTeX math ($...$ / $$...$$) where appropriate.
- Do NOT add ::widget markers, new headings, or any preamble/explanation.
- Keep the same language ("${lang}") unless the instruction asks to translate.
- Output ONLY the replacement Markdown — no code fence, no commentary.

${languageStyleGuide(lang)}`;
  const text = await runStreamed(prompt, ctx?.progress, { modelConfig });
  // Re-apply the selection's leading/trailing whitespace so an in-place splice
  // never merges words with neighbouring text.
  const lead = sel.match(/^\s*/)[0];
  const trail = sel.match(/\s*$/)[0];
  return { text: lead + (text || "").trim() + trail };
}

// Vision: does the (generated) image carry readable text in the source language?
// Used during translation to decide whether to regenerate it in the target lang.
export async function detectImageTextLanguage({ imagePath, sourceLang, targetLang, modelConfig }) {
  let bytes;
  try {
    bytes = readFileSync(imagePath);
  } catch {
    return { hasText: false, language: "", translate: false };
  }
  const content = [
    {
      type: "text",
      text: `Look at this image. Does it contain any rendered, human-readable TEXT (words, labels, captions, UI text, annotations)? If yes, what language is that text written in? Reply with ONLY a JSON object: {"hasText": boolean, "language": "<language name or BCP-47 code>", "isSourceLanguage": boolean} where isSourceLanguage is true when the visible text is written in language "${sourceLang || "?"}". Decorative shapes or icons without words count as hasText=false.`,
    },
    {
      type: "image",
      source: { type: "base64", media_type: guessImageMime(imagePath), data: bytes.toString("base64") },
    },
  ];
  async function* userPrompt() {
    yield { type: "user", message: { role: "user", content }, parent_tool_use_id: null };
  }
  let text = "";
  for await (const m of query({
    prompt: userPrompt(),
    options: { maxTurns: 1, ...claudeBaseOptions(modelOptions(modelConfig)) },
  })) {
    if (m.type === "result" && m.subtype === "success") text = m.result;
  }
  const parsed = extractJson(text) || {};
  const hasText = !!parsed.hasText;
  const isSrc = parsed.isSourceLanguage === true;
  const translate =
    hasText && isSrc && String(sourceLang || "").toLowerCase() !== String(targetLang || "").toLowerCase();
  return { hasText, language: parsed.language || "", translate };
}

export async function generateTest({ topic, language, courseFormat, submodulePath, article, modelConfig, category, genProfile, structure, learnerProfile }, ctx) {
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
      : `\nINTERLEAVING: ALSO include 1-2 CUMULATIVE questions that connect THIS submodule to an EARLIER one in the course outline below (mix in a prior concept) — interleaving strengthens retention. Tag their "concept" accordingly.\nCourse outline:\n${outline}\n`;
  const prompt = `You are writing a short comprehension test for a submodule of
a course on "${topic}" (language: ${lang}).

${courseFormatGuide(courseFormat, lang)}
${categoryPedagogyBlock(category, lang, intensity)}${learnerProfileBlock(learnerProfile)}${recallGuide}
Submodule: ${submodulePath?.title || ""}${submodulePath?.summary ? ` — ${submodulePath.summary}` : ""}

${isPodcast ? "Episode transcript the test must be based on" : "Article the test must be based on"}:
<article>
${article}
</article>
${interleaveGuide}

Write a POOL of 10-16 multiple-choice questions that check real UNDERSTANDING
of this article — not trivia or verbatim recall. Only a random subset is shown
per attempt, so make them VARIED and non-overlapping (cover different points;
avoid near-duplicate questions). Each question:
- has 3-5 plausible options, exactly ONE correct;
- "correct" is the 0-based index of the right option;
- includes a one-sentence "explanation" of why the answer is right;
- includes a "concept": a 2-4 word tag naming the single concept/skill it
  checks (in language "${lang}"), used later for spaced review and weak-spot
  diagnosis;
- is written in language "${lang}".

CRITICAL — make options indistinguishable except by their meaning:
- All options must be roughly the same length and level of detail. The correct
  answer must NOT be longer, more specific, more hedged, or more "textbook"
  than the distractors — if it stands out by wording or length, the question is
  useless. Write distractors that are just as confident and concrete.
- Make the distractors genuinely tempting (common misconceptions, near-misses),
  not obviously wrong throwaways.
- Vary which option is correct from question to question; do not default to the
  first option.

${languageStyleGuide(lang)}

Output ONLY a JSON object on a single line, no prose, no markdown fence:
{"questions":[{"text":"...","options":["...","..."],"correct":0,"explanation":"...","concept":"..."}]}`;
  ctx?.progress?.({ label: "thinking" });
  const text = await runStreamed(prompt, ctx?.progress, { modelConfig });
  const parsed = extractJson(text);
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
      // The model tends to place the correct option first; shuffle so position
      // carries no signal. Track the correct option through the permutation.
      const order = options.map((_, i) => i);
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      return {
        text: q.text.trim(),
        options: order.map((i) => options[i]),
        correct: order.indexOf(correct),
        explanation: typeof q.explanation === "string" ? q.explanation.trim() : "",
        concept: typeof q.concept === "string" ? q.concept.trim() : "",
      };
    })
    .filter(Boolean);
}

// ── Flashcards (active recall) ──────────────────────────────────────────────

function normalizeFlashcards(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((c) => {
      if (!c) return null;
      const front = typeof c.front === "string" ? c.front.trim() : "";
      const back = typeof c.back === "string" ? c.back.trim() : "";
      if (!front || !back) return null;
      // Mechanical answer-leak guard: a front that contains the full back
      // tests nothing.
      if (back.length > 3 && front.toLowerCase().includes(back.toLowerCase())) return null;
      const concept = typeof c.concept === "string" ? c.concept.trim() : "";
      const section = typeof c.section === "string" ? c.section.trim() : "";
      return {
        front,
        back,
        ...(concept ? { concept } : {}),
        ...(section ? { section } : {}),
      };
    })
    .filter(Boolean)
    .slice(0, 14);
}

export async function generateFlashcards(
  { topic, language, courseFormat, submodulePath, article, modelConfig, category, genProfile, learnerProfile },
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

${categoryPedagogyBlock(category, lang, intensity)}${learnerProfileBlock(learnerProfile)}
Submodule: ${submodulePath?.title || ""}${submodulePath?.summary ? ` — ${submodulePath.summary}` : ""}

The ${source} the learner just studied:
<article>
${article}
</article>

${flashcardRulesBlock(lang, source)}

${languageStyleGuide(lang)}

Output ONLY a JSON object with the KEPT cards on a single line, no prose, no markdown fence:
{"flashcards":[{"front":"...","back":"...","concept":"...","section":"..."}]}`;
  ctx?.progress?.({ label: "thinking" });
  const text = await runStreamed(prompt, ctx?.progress, { modelConfig });
  const parsed = extractJson(text);
  return { flashcards: normalizeFlashcards(parsed?.flashcards) };
}

/**
 * Translate the human-readable strings inside a template widget's params.
 * Structure-preserving: the result is re-validated by the shared normalizer
 * and the SOURCE params are returned on any failure — translation must never
 * break a widget.
 */
export async function translateTemplateParams(
  { sourceLang, targetLang, template, params, modelConfig },
  ctx
) {
  const prompt = `Translate the human-readable strings inside this learning-widget params JSON
from language "${sourceLang || "auto"}" into language "${targetLang}".
Widget template: "${template}".
Rules:
- Translate ONLY display text: questions, options, explanations, prompts, labels,
  step titles/texts, card fronts/backs, list items, bucket names, hints, accepted
  answers, notes, tasks.
- Do NOT change keys, numbers, booleans, indexes, or array order/length.
- Keep these fields VERBATIM: name, expr, format, suffix, code, codeLang,
  language, mode, solution, expected_output, stdin.
- In fillblank texts keep the literal gap token "___" intact.
Output ONLY the same JSON object shape on a single line, no prose, no fence.

${JSON.stringify(params ?? {})}`;
  ctx?.progress?.({ label: "translating" });
  const text = await runStreamed(prompt, ctx?.progress, { modelConfig });
  const parsed = extractJson(text);
  const tw = parsed ? normalizeTemplateWidget({ template, params: parsed }) : null;
  return { params: tw ? tw.params : params };
}

// ── Fact-check (post-ready background verification pass) ────────────────────

function normalizeFactCheck(parsed) {
  const verdicts = new Set(["confirmed", "wrong", "unverifiable"]);
  const claims = (Array.isArray(parsed?.claims) ? parsed.claims : [])
    .map((c) => {
      if (!c || typeof c.claim !== "string" || !c.claim.trim()) return null;
      return {
        claim: c.claim.trim(),
        verdict: verdicts.has(c.verdict) ? c.verdict : "unverifiable",
        correction: typeof c.correction === "string" ? c.correction.trim() : "",
        sourceUrl: typeof c.sourceUrl === "string" ? c.sourceUrl.trim() : "",
      };
    })
    .filter(Boolean)
    .slice(0, 10);
  const patches = (Array.isArray(parsed?.patches) ? parsed.patches : [])
    .map((p) => {
      const find = typeof p?.find === "string" ? p.find : "";
      const replace = typeof p?.replace === "string" ? p.replace : "";
      if (!find.trim() || !replace.trim() || find === replace) return null;
      return { find, replace };
    })
    .filter(Boolean)
    .slice(0, 10);
  return { claims, patches };
}

export async function verifyFacts(
  { topic, language, category, article, sources, modelConfig },
  ctx
) {
  if (typeof article !== "string" || !article.trim()) {
    throw new Error("article required for fact check");
  }
  const lang = (language || "en").trim();
  const prompt = `You are a fact-checker for one lesson of a course on "${topic}" (language "${lang}").

<article>
${article}
</article>

Sources the writer claims to have consulted:
<sources>
${JSON.stringify(sources ?? [], null, 2)}
</sources>

${factCheckBlock(lang)}

Output ONLY a JSON object on a single line, no prose, no markdown fence:
{"claims":[{"claim":"...","verdict":"confirmed","correction":"","sourceUrl":""}],"patches":[{"find":"...","replace":"..."}]}`;
  ctx?.progress?.({ label: "fact-checking" });
  const text = await runStreamed(prompt, ctx?.progress, {
    web: true,
    modelConfig,
    category,
    stage: "verify",
    maxTurns: MAX_AGENT_TURNS,
  });
  return normalizeFactCheck(extractJson(text));
}

// ── Spaced-repetition support: free-recall grading, leech rewrite ───────────

export async function gradeAnswer({ topic, language, card, userAnswer, modelConfig }, ctx) {
  const lang = (language || "en").trim();
  const front = (card?.front || "").toString().trim();
  const back = (card?.back || "").toString().trim();
  const answer = (userAnswer || "").toString().trim();
  if (!front || !back) throw new Error("card front/back required");
  const prompt = `You are grading one spaced-repetition answer for a course on "${topic}".

Card question:
<front>
${front}
</front>
Reference answer:
<back>
${back}
</back>
Learner's answer (free text):
<answer>
${answer || "(empty)"}
</answer>

${gradeAnswerBlock(lang)}

Output ONLY a JSON object on a single line, no prose, no markdown fence:
{"rating":3,"feedback":"..."}`;
  ctx?.progress?.({ label: "thinking" });
  const text = await runStreamed(prompt, ctx?.progress, { modelConfig });
  const parsed = extractJson(text);
  const rating = Math.min(4, Math.max(1, Math.round(Number(parsed?.rating)) || 2));
  const feedback = typeof parsed?.feedback === "string" ? parsed.feedback.trim() : "";
  return { rating, feedback };
}

export async function rewriteLeechCard({ topic, language, card, article, lapses, modelConfig }, ctx) {
  const lang = (language || "en").trim();
  const front = (card?.front || "").toString().trim();
  const back = (card?.back || "").toString().trim();
  if (!front || !back) throw new Error("card front/back required");
  const prompt = `This flashcard from a course on "${topic}" keeps being forgotten
(failed ${Number(lapses) || "many"} times) — it is a "leech".

The card:
<front>
${front}
</front>
<back>
${back}
</back>

The lesson it came from:
<article>
${(article || "").toString()}
</article>

${leechRewriteBlock(lang)}

Output ONLY a JSON object on a single line, no prose, no markdown fence:
{"cards":[{"front":"...","back":"...","concept":"..."}]}`;
  ctx?.progress?.({ label: "thinking" });
  const text = await runStreamed(prompt, ctx?.progress, { modelConfig });
  const parsed = extractJson(text);
  return { cards: normalizeFlashcards(parsed?.cards).slice(0, 3) };
}

// ── Homework assignments ────────────────────────────────────────────────────

const ASSIGNMENT_TYPES = ["image", "text", "document", "archive", "github", "code"];
const CRITICALITIES = ["critical", "major", "minor"];

function guessImageMime(p) {
  const s = (p || "").toLowerCase();
  if (s.endsWith(".png")) return "image/png";
  if (s.endsWith(".jpg") || s.endsWith(".jpeg")) return "image/jpeg";
  if (s.endsWith(".webp")) return "image/webp";
  if (s.endsWith(".gif")) return "image/gif";
  return "image/png";
}

function normalizeAssignments(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  raw.forEach((a, i) => {
    if (!a || typeof a.title !== "string" || !a.title.trim()) return;
    if (typeof a.prompt !== "string" || !a.prompt.trim()) return;
    let type = typeof a.type === "string" ? a.type.trim().toLowerCase() : "text";
    if (!ASSIGNMENT_TYPES.includes(type)) type = "text";
    const entry = {
      id: `a${i + 1}`,
      title: a.title.trim(),
      prompt: a.prompt.trim(),
      type,
      criteria: typeof a.criteria === "string" ? a.criteria.trim() : "",
    };
    if (type === "code") {
      // Autograded code task: needs a runnable language and at least one IO
      // test case; otherwise degrade to "text" so the chain stays usable.
      const language = normalizeCodeLang(a.language);
      const rawStr = (v, max) =>
        typeof v === "string" && v.trim() && v.length <= max ? v : "";
      const tests = (Array.isArray(a.tests) ? a.tests : [])
        .filter((t) => t && rawStr(t.expected_output, 2000))
        .slice(0, 6)
        .map((t) => ({
          ...(typeof t.stdin === "string" && t.stdin && t.stdin.length <= 2000
            ? { stdin: t.stdin }
            : {}),
          expected_output: t.expected_output,
          ...(t.hidden === true ? { hidden: true } : {}),
        }));
      const starter = rawStr(a.starter_code, 8000);
      if (!language || tests.length === 0) {
        entry.type = "text";
      } else {
        entry.language = language;
        entry.tests = tests;
        if (starter) entry.starter_code = starter;
      }
    }
    out.push(entry);
  });
  return out.slice(0, 4);
}

/// Render the autograde results (real execution) for the review prompt.
function autogradeBlock(ag) {
  if (!ag || typeof ag.total !== "number" || ag.total === 0) return "";
  const lines = (Array.isArray(ag.cases) ? ag.cases : [])
    .filter((c) => c && c.pass === false)
    .map((c) => {
      if (c.hidden) return `- case ${c.idx + 1} (hidden): FAILED`;
      const parts = [`- case ${c.idx + 1}: FAILED`];
      if (c.phase === "compile") parts.push("(compile error)");
      if (c.timed_out) parts.push("(timed out)");
      if (typeof c.expected === "string")
        parts.push(`expected=${JSON.stringify(c.expected)} got=${JSON.stringify(c.got ?? "")}`);
      if (typeof c.stderr === "string" && c.stderr) parts.push(`stderr: ${c.stderr}`);
      return parts.join(" ");
    });
  return `\nAUTOMATED TEST RESULTS (ground truth — the submitted code was actually executed):
${ag.passed}/${ag.total} test cases passed.
${lines.length ? lines.join("\n") + "\n" : ""}Rules for code submissions:
- If ANY case failed, the verdict MUST be "revise" and your remarks must explain
  WHY those cases fail, referencing the concrete inputs/outputs above.
- If ALL cases passed, judge code quality, clarity, and the grading criteria;
  with no critical/major remarks, the verdict is "passed". Never claim a test
  outcome different from the results above.\n`;
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
  // Never pass while critical/major issues remain.
  if (remarks.some((r) => r.criticality === "critical" || r.criticality === "major")) {
    verdict = "revise";
  }
  return {
    remarks,
    verdict,
    summary: typeof parsed?.summary === "string" ? parsed.summary.trim() : "",
  };
}

/**
 * Design a short chain of practical homework assignments for a submodule.
 * @returns {Promise<{assignments: Array<{id,title,prompt,type,criteria}>}>}
 */
export async function generateAssignments({ topic, language, courseFormat, submodulePath, article, modelConfig, category, genProfile, learnerProfile }, ctx) {
  if (["podcast_series", "encyclopedia", "documentation"].includes(normalizeCourseFormat(courseFormat))) {
    return { assignments: [] };
  }
  if (typeof article !== "string" || !article.trim()) {
    throw new Error("article required for assignment generation");
  }
  const lang = (language || "en").trim();
  const intensity = genProfile?.pedagogyIntensity || "standard";
  const fadingGuide =
    intensity === "max"
      ? `\nSCAFFOLDING (worked -> guided -> independent): make the chain a faded progression — (1) a WORKED example the learner reproduces/completes, (2) a GUIDED task with hints/partial scaffolding, (3) an INDEPENDENT task with none. This completion-problem ramp beats jumping straight to independent production.\n`
      : "";
  const isCodey = ["programming", "data_ai"].includes(category);
  const codeTypeLine = isCodey
    ? `\n- "code"     — an AUTOGRADED coding task: the learner writes a complete
               program in the app's editor and it is EXECUTED against your test
               cases. Prefer this over archive/github for small coding tasks.`
    : "";
  const codeRules = isCodey
    ? `\nCODE ASSIGNMENTS (type "code") — extra fields:
- "language": one of python|javascript|go|c|cpp|rust|java (the language this submodule teaches);
- "starter_code": optional runnable scaffold with a TODO comment;
- "tests": 2-6 IO cases [{"stdin":"...","expected_output":"...","hidden":true|false}].
HARD RULES for code tasks: the task is a COMPLETE program that reads stdin and
prints stdout; state the EXACT input/output format in "prompt" and include at
least one example input/output pair there; at least one test must be non-hidden;
"expected_output" must be the EXACT stdout of a correct solution; output must be
DETERMINISTIC (no randomness, time, or hash-order dependence); standard library
only; each run finishes in under 5 seconds.\n`
    : "";
  const prompt = `You are designing practical homework for one submodule of a
course on "${topic}" (language: ${lang}).

${courseFormatGuide(courseFormat, lang)}
${categoryPedagogyBlock(category, lang, intensity)}${learnerProfileBlock(learnerProfile)}
Submodule: ${submodulePath?.title || ""}${submodulePath?.summary ? ` — ${submodulePath.summary}` : ""}

The article the learner just studied:
<article>
${article}
</article>
${fadingGuide}
Design a SHORT CHAIN of 1-3 practical assignments that make the learner APPLY
what they learned, ordered as a progression (each builds on the previous).
For each assignment pick the single best submission type:
- "image"    — the learner produces a drawing/sketch/diagram/photo (e.g. "draw a
               cube in two-point perspective"). Best for visual/art/design skills.
- "text"     — a written answer, analysis, or short essay submitted as text.
- "document" — the learner uploads a file (report, notes, PDF, spreadsheet).
- "archive"  — the learner uploads a .zip of a small program/project.
- "github"   — the learner submits a link to a GitHub repository.${codeTypeLine}
Match the type to the skill: drawing→image, writing/analysis→text,
coding→${isCodey ? "code (small tasks) or archive/github (multi-file projects)" : "archive or github"}, longer deliverables→document.
${codeRules}
For each assignment write clear "criteria" — the concrete, checkable things a
reviewer grades against (this drives an iterative review-and-revise loop).
Tasks must be concrete and achievable from the article; no busywork.
All text in language "${lang}".

${languageStyleGuide(lang)}

Output ONLY a JSON object on a single line, no prose, no markdown fence:
{"assignments":[{"title":"...","prompt":"...","type":"image|text|document|archive|github${isCodey ? "|code" : ""}","criteria":"..."${isCodey ? `,"language"?,"starter_code"?,"tests"?` : ""}}]}`;
  ctx?.progress?.({ label: "thinking" });
  const text = await runStreamed(prompt, ctx?.progress, { modelConfig });
  const parsed = extractJson(text);
  return { assignments: normalizeAssignments(parsed?.assignments) };
}

/**
 * Review one homework submission against its assignment. Vision-aware (images)
 * and web-aware (github links). Returns remarks + criticality + verdict.
 * @returns {Promise<{remarks:Array<{text,criticality}>, verdict:"passed"|"revise", summary}>}
 */
export async function reviewAssignment(params, ctx) {
  const { topic, language, assignment, submission, history, modelConfig } = params;
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
    ? `\nThe learner submitted a GitHub repository: ${sub.githubUrl}\nUse WebFetch to inspect its README and key files before judging.\n`
    : "";
  const textBlock =
    typeof sub.text === "string" && sub.text.trim()
      ? `\nThe learner's submission (text / extracted file content):\n<submission>\n${sub.text.slice(0, 24000)}\n</submission>\n`
      : "";
  const imageNote = images.length
    ? `\nThe submission includes ${images.length} image(s) shown below — examine them visually.\n`
    : "";

  const promptText = `You are a strict but encouraging reviewer grading one homework assignment in a course on "${topic}". Respond in language "${lang}".

Assignment: ${a.title || ""}
Task: ${a.prompt || ""}
${a.criteria ? `Grading criteria:\n${a.criteria}\n` : ""}
${histBlock}Now review the learner's NEW submission below.${imageNote}${githubBlock}${textBlock}${autogradeBlock(sub.autograde)}
Judge the submission against the task and criteria. Produce:
- "remarks": specific, actionable points. Each has "text" and "criticality" ∈
  "critical" | "major" | "minor". critical/major mean the work does not yet meet
  the assignment.
- "verdict": "passed" ONLY if there are no critical or major remarks AND the work
  genuinely satisfies the assignment; otherwise "revise".
- "summary": 1-3 sentences telling the learner what to fix next (or congratulating
  them if passed). Encouraging but honest.
Reference what you actually see. Don't pass weak work; don't nitpick endlessly —
minor remarks alone don't block passing.

${naturalLanguageGuide(lang)}

Output ONLY a single-line JSON object:
{"remarks":[{"text":"...","criticality":"major"}],"verdict":"revise","summary":"..."}`;

  const content = [{ type: "text", text: promptText }];
  for (const im of images) {
    try {
      const bytes = readFileSync(im.path);
      content.push({
        type: "image",
        source: { type: "base64", media_type: guessImageMime(im.path), data: bytes.toString("base64") },
      });
    } catch (e) {
      content.push({ type: "text", text: `(could not read image ${im.path}: ${e.message})` });
    }
  }

  async function* userPrompt() {
    yield { type: "user", message: { role: "user", content }, parent_tool_use_id: null };
  }

  ctx?.progress?.({ label: "reviewing" });
  const wantWeb = !!sub.githubUrl; // only github submissions need to fetch the web
  const options = buildClaudeOptions({ web: wantWeb, modelConfig });
  if (!wantWeb) options.maxTurns = 1; // vision/text need a single turn
  let text = "";
  for await (const m of query({ prompt: userPrompt(), options })) {
    if (m.type === "result" && m.subtype === "success") text = m.result;
  }
  return normalizeReview(extractJson(text));
}

/**
 * Vision review of candidate images for one image-widget slot.
 * @param {{language:string, description:string, alt:string, topic:string, candidates:{path:string}[]}} params
 * @returns {Promise<{pick: number|null, reason: string, refinedQuery: string}>}
 */
export async function reviewImages(params, ctx) {
  const { language, description, alt, topic, candidates, modelConfig } = params;
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

  const content = [{ type: "text", text: promptText }];
  for (let i = 0; i < candidates.length; i++) {
    const p = candidates[i].path;
    let bytes;
    try {
      bytes = readFileSync(p);
    } catch (e) {
      content.push({ type: "text", text: `Candidate ${i}: failed to read file (${e.message})` });
      continue;
    }
    content.push({ type: "text", text: `Candidate ${i}:` });
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/jpeg",
        data: bytes.toString("base64"),
      },
    });
  }

  async function* userPrompt() {
    yield {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
    };
  }

  ctx?.progress?.({ label: "reviewing" });
  let text = "";
  for await (const m of query({
    prompt: userPrompt(),
    options: { maxTurns: 1, ...claudeBaseOptions(modelOptions(modelConfig)) },
  })) {
    if (m.type === "result" && m.subtype === "success") {
      text = m.result;
    }
  }
  const parsed = extractJson(text);
  return {
    pick: typeof parsed.pick === "number" ? parsed.pick : null,
    reason: typeof parsed.reason === "string" ? parsed.reason : "",
    refinedQuery: typeof parsed.refinedQuery === "string" ? parsed.refinedQuery : "",
  };
}

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

Use WebSearch and, when useful, WebFetch. Return source pages that are likely to
contain the real image; the app can extract og:image, twitter:image, srcset,
JSON-LD ImageObject, and large <img> assets from those pages.

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
- Prefer large, full-resolution images — at least 800px on the longer side.
  Skip thumbnails, icons, sprites, avatars, and tiny preview images; when a page
  offers several sizes, choose the full-size/original asset, not a small preview.
- Return 0-8 candidates. If nothing credible is found, return [] and provide a
  better refinedQuery.

Output ONLY single-line JSON:
{"candidates":[{"title":"...","source":"https://...","url":"https://... or empty","reason":"short reason in ${lang}"}],"refinedQuery":"english query for another try or empty"}`;

  ctx?.progress?.({ label: "searching images", detail: searchQuery || description });
  const text = await runStreamed(prompt, ctx?.progress, { web: true, modelConfig });
  const parsed = extractJson(text);
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

/**
 * Derive ONE short, precise web-image search query for a single image/gallery
 * item. Pure text transform (no web): distills the learner caption / verbose
 * generation prompt into the simplest query that finds the exact real thing.
 * Runs on the utility (cheap) model. Used lazily at search time and cached.
 * @param {{description?:string, prompt?:string, alt?:string, topic:string, language?:string, modelConfig?:object}} params
 * @returns {Promise<{query:string}>}
 */
export async function imageSearchQuery({ description, prompt: intentPrompt, topic, language, modelConfig }, ctx) {
  const lang = (language || "en").trim();
  const caption = (description || "").trim();
  const intent = (intentPrompt || "").trim();
  const prompt = `Write ONE short web image-search query, in language "${lang}", that will find the EXACT real thing this course image depicts.

Course topic: "${topic}"
Image caption: "${caption}"${intent && intent !== caption ? `\nSearch intent: "${intent}"` : ""}

Rules:
- Name the specific entity (proper name of the place/person/object/work) and add only what disambiguates it: its city/country, era, or creator.
- 3-8 words. No quotes, no boolean operators, no site: filters, no trailing punctuation.
- Do NOT pad with the course topic or generic words ("photo", "image", "example").
- Keep it in the most searchable form for this subject (usually the local-language proper name).

Output ONLY single-line JSON: {"query":"..."}`;
  ctx?.progress?.({ label: "query", detail: caption });
  const text = await runStreamed(prompt, ctx?.progress, { web: false, modelConfig });
  const parsed = extractJson(text);
  return { query: typeof parsed?.query === "string" ? parsed.query.trim().slice(0, 160) : "" };
}

// One option/text normalizer shared by the adaptive wizard.
function normalizeWizardQuestion(q) {
  if (!q || typeof q.text !== "string") return null;
  const text = q.text.trim();
  if (!text) return null;
  const options = Array.isArray(q.options)
    ? q.options.filter((o) => typeof o === "string" && o.trim().length > 0).map((o) => o.trim())
    : [];
  // Default to multi when unspecified — multi-select is the wizard norm.
  const multi = q.multi !== false;
  return { text, options, multi };
}

// Render the running interview so the model can ask a question that BUILDS on it.
function answeredBlock(answered) {
  if (!Array.isArray(answered) || answered.length === 0) {
    return "(none yet — this is the FIRST question)";
  }
  return answered
    .map((qa, i) => `${i + 1}. Q: ${qa?.question ?? ""}\n   A: ${qa?.answer ?? ""}`)
    .join("\n");
}

/**
 * Adaptive clarifying interview: given the answers so far, return the single most
 * valuable NEXT question (that builds on prior answers), or done=true once enough
 * has been gathered. The caller asks one question at a time, 3-10 total.
 * @param {{topic:string, language:string, courseFormat?:string, answered?:Array<{question:string,answer:string}>}} params
 * @returns {Promise<{title?:string, done:boolean, question?:{text:string,options:string[],multi:boolean}}>}
 */
export async function wizardNextQuestion(
  { topic, language, courseFormat, answered, modelConfig, spaceSources, spaceLinks, spaceDirs, spaceStrict, reuseThreadPerTopic, reuseSessionKey },
  ctx
) {
  if (typeof topic !== "string" || !topic.trim()) {
    throw new Error("topic must be a non-empty string");
  }
  const lang = (language || "en").trim();
  const asked = Array.isArray(answered) ? answered : [];
  const isFirst = asked.length === 0;
  const wizardFormat = normalizeCourseFormat(courseFormat);
  // Short interviews: a single lesson or a roadmap need 1-3 focused questions,
  // not the full 3-10 learner-profile interview.
  const isShort =
    wizardFormat === "single_lesson" ||
    wizardFormat === "roadmap" ||
    wizardFormat === "fact_check";
  const minQ = isShort ? 1 : 3;
  const maxQ = isShort ? 3 : 10;
  const subjectNoun =
    wizardFormat === "single_lesson" || wizardFormat === "fact_check"
      ? "lesson"
      : wizardFormat === "roadmap"
        ? "roadmap"
        : "course";
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
from a previous answer. Never repeat ground already covered, and never ask the
learner to choose the generation format again. Skip pleasantries.

${
  wizardFormat === "single_lesson"
    ? `Cover only what materially changes this ONE lesson — primarily the goal
(what exactly they want covered and from what angle) and their current level.
Do not interview about weekly time budget or course-scale preferences.`
    : wizardFormat === "roadmap"
      ? `Cover only what materially changes the ROADMAP — primarily the learner's
current level and the precise target outcome (job, project, exam, deadline).
Do not interview about lesson formats, weekly schedules, or assessments.`
      : `By the END of the interview you must have covered these four LEARNER-PROFILE
dimensions (they drive personalization of every future lesson): (1) current
level, (2) goals — what they want to be able to DO, (3) weekly time budget,
(4) prior/adjacent knowledge. When no better topic-specific question exists,
ask about an uncovered dimension; weave it naturally into the topic.`
}

Conduct between ${minQ} and ${maxQ} questions in TOTAL. You have asked ${asked.length} so far.
- If you have asked FEWER than ${minQ}, you MUST ask another question (done=false).
- If you have asked AT LEAST ${minQ} and now have enough to build an excellent,
  specific ${subjectNoun}, set done=true and omit "question".
- If you have asked ${maxQ} or more, you MUST set done=true.
- Otherwise return the next "question".

When you ask a question, also provide 3-5 realistic, mutually-distinct, concrete,
topic-specific answer options (short phrases in "${lang}", not generic
"low/medium/high"; e.g. for painting: "масло", "акварель", "карандаш и уголь").
The learner has a free-text fallback, so do NOT add an "other" option. Also set
"multi": true by default (preferences, scope, materials, goals usually accept
several answers); set "multi": false ONLY when answers are genuinely mutually
exclusive (time per week, current level, work vs hobby).
${wizardQuestionGuide(courseFormat, lang)}
${isFirst ? `Also generate a short display "title" for the course: a concise noun phrase, 2-6 words in "${lang}", NOT copying the raw request, no quotes, no "course about/on" wrapper.\n` : ""}
Write everything in language "${lang}".

${languageStyleGuide(lang)}

Output ONLY a JSON object on a single line, no prose, no markdown fence.
Shape when asking: {${isFirst ? `"title":"...",` : ""}"done":false,"question":{"text":"...","options":["...","..."],"multi":true}}
Shape when finished: {"done":true}`;
  // dirs grants the agent read access to the space's attached directories so it
  // can actually inspect them when forming questions (no dirs -> single turn).
  const text = await runStreamed(prompt, ctx?.progress, {
    modelConfig,
    dirs: spaceDirs,
    // LEG-36: reuse one session across the topic's questions (+ structure).
    reuseKey: reuseThreadPerTopic ? reuseSessionKey : undefined,
  });
  const parsed = extractJson(text) || {};
  // Honor an explicit done; otherwise a missing/invalid question also means done.
  const question = parsed.done === true ? null : normalizeWizardQuestion(parsed.question);
  const out = { done: !question };
  if (question) out.question = question;
  if (isFirst) {
    const title = normalizeCourseTitle(parsed?.title);
    if (title) out.title = title;
  }
  return out;
}

// ── Learner profile + entry diagnostic ──────────────────────────────────────

const LEARNER_LEVELS = ["novice", "amateur", "intermediate", "advanced"];

export async function extractLearnerProfile({ topic, language, courseMd, modelConfig }, ctx) {
  const lang = (language || "en").trim();
  const prompt = `From this pre-course interview (wizard Q&A) extract the LEARNER PROFILE.

<course-md>
${courseMd || ""}
</course-md>

Fields:
- "level": one of ${JSON.stringify(LEARNER_LEVELS)} — infer conservatively from what they said;
- "goals": 1-2 sentences in language "${lang}" — what they want to be able to DO;
- "weeklyMinutes": integer — their weekly time budget in minutes (estimate from answers; 0 if truly unknown);
- "priorKnowledge": 1-2 sentences in "${lang}" — what they already know (adjacent skills count); "" if none mentioned;
- "examplesStyle": short phrase in "${lang}" for the example style they'd respond to (e.g. practical/code-first, theory-first, visual); "" if no signal.

Infer only from the interview — do not invent facts. Concise values, no commentary.

Output ONLY a JSON object on a single line, no prose, no markdown fence:
{"level":"...","goals":"...","weeklyMinutes":120,"priorKnowledge":"...","examplesStyle":"..."}`;
  ctx?.progress?.({ label: "thinking" });
  const text = await runStreamed(prompt, ctx?.progress, { modelConfig });
  const parsed = extractJson(text) || {};
  return { profile: normalizeLearnerProfile(parsed) };
}

function normalizeLearnerProfile(p) {
  const out = { version: 1 };
  if (LEARNER_LEVELS.includes(p?.level)) out.level = p.level;
  if (typeof p?.goals === "string" && p.goals.trim()) out.goals = p.goals.trim();
  const mins = Math.round(Number(p?.weeklyMinutes));
  if (Number.isFinite(mins) && mins > 0) out.weeklyMinutes = Math.min(mins, 7 * 24 * 60);
  if (typeof p?.priorKnowledge === "string" && p.priorKnowledge.trim())
    out.priorKnowledge = p.priorKnowledge.trim();
  if (typeof p?.examplesStyle === "string" && p.examplesStyle.trim())
    out.examplesStyle = p.examplesStyle.trim();
  return out;
}

export async function generateDiagnostic({ topic, language, courseMd, learnerProfile, modelConfig }, ctx) {
  const lang = (language || "en").trim();
  const prompt = `You are writing a short ENTRY DIAGNOSTIC for a learner about to
start a personalized course on "${topic}" (language "${lang}"). Its purpose is to
find WHERE this learner's knowledge stops, so the course can skip what they know
and scaffold what they don't.

${learnerProfileBlock(learnerProfile)}
The pre-course interview:
<course-md>
${courseMd || ""}
</course-md>

Write 5-8 multiple-choice questions that ladder in difficulty:
- start at fundamentals a motivated beginner could answer, end at questions only
  someone genuinely experienced in "${topic}" would get right;
- each question tests UNDERSTANDING (why/how/what-happens-if), not trivia;
- options must be plausible and mutually exclusive — distractors should reflect
  real misconceptions; no "all of the above";
- the question must not leak its answer; keep options similar in length/register;
- each question carries: "text", "options" (3-4 strings), "correct" (0-based
  index), "explanation" (1 sentence), "concept" (2-4 word tag in "${lang}"),
  "difficulty" (1 fundamentals / 2 working knowledge / 3 advanced).
All text in language "${lang}".

${languageStyleGuide(lang)}

Output ONLY a JSON object on a single line, no prose, no markdown fence:
{"questions":[{"text":"...","options":["..."],"correct":0,"explanation":"...","concept":"...","difficulty":1}]}`;
  ctx?.progress?.({ label: "thinking" });
  const text = await runStreamed(prompt, ctx?.progress, { modelConfig });
  const parsed = extractJson(text);
  return { questions: normalizeDiagnostic(parsed?.questions) };
}

function normalizeDiagnostic(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((q) => {
      if (!q || typeof q.text !== "string" || !q.text.trim()) return null;
      const options = Array.isArray(q.options)
        ? q.options.filter((o) => typeof o === "string" && o.trim()).map((o) => o.trim())
        : [];
      if (options.length < 3) return null;
      const correct = Number.isInteger(q.correct) && q.correct >= 0 && q.correct < options.length ? q.correct : 0;
      return {
        text: q.text.trim(),
        options,
        correct,
        explanation: typeof q.explanation === "string" ? q.explanation.trim() : "",
        concept: typeof q.concept === "string" ? q.concept.trim() : "",
        difficulty: [1, 2, 3].includes(q.difficulty) ? q.difficulty : 2,
      };
    })
    .filter(Boolean)
    .slice(0, 8);
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

${languageStyleGuide(lang)}

Output ONLY a JSON object on a single line, no prose, no markdown fence.
Shape: {"topic":"...","title":"...","reason":"..."}`;
  ctx?.progress?.({ label: "thinking" });
  const text = await runStreamed(prompt, ctx?.progress, { modelConfig });
  const parsed = extractJson(text);
  const topic = normalizeCourseTitle(parsed?.topic);
  if (!topic) throw new Error("Claude response missing topic");
  return {
    topic,
    title: normalizeCourseTitle(parsed?.title) || topic,
    reason: typeof parsed?.reason === "string" ? parsed.reason.trim().slice(0, 240) : "",
  };
}

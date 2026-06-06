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
import { context7StdioServer, mediawikiStdioServer } from "../lib/reference-mcp.mjs";
import {
  categoryClassifyGuide,
  categoryPreferredSourcesBlock,
  normalizeCategory,
} from "../lib/categories.mjs";

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
function buildClaudeOptions({ maxTurns, web, braveApiKey, modelConfig, dirs } = {}) {
  const readDirs = Array.isArray(dirs) ? dirs.filter(Boolean) : [];
  const hasTools = web || !!braveApiKey || readDirs.length > 0;
  const options = {
    // Generous ceiling so the agent never errors with "max turns reached"
    // before it writes the article. Research depth is throttled in the prompt
    // (a few targeted lookups, then write), not by starving the turn budget.
    maxTurns: maxTurns ?? (hasTools ? 10 : 1),
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
  }
  if (braveApiKey) {
    options.mcpServers = {
      ...(options.mcpServers || {}),
      brave: { type: "stdio", ...braveStdioServer(braveApiKey) },
    };
    allowedTools.push("mcp__brave__brave_web_search", "mcp__brave__brave_image_search");
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
  return options;
}

async function runStreamed(prompt, onProgress, opts) {
  let text = "";
  // With web/Brave tools the agent may take several turns (search, read,
  // write); buildClaudeOptions picks the turn budget from the enabled tools.
  const options = buildClaudeOptions({
    web: opts?.web,
    braveApiKey: opts?.braveApiKey,
    modelConfig: opts?.modelConfig,
    dirs: opts?.dirs,
  });
  const rec = devlog.startCall({ backend: "claude", prompt, model: opts?.modelConfig?.model });
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
    }
  }
  } catch (e) {
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
  return `Previously written submodules — read them for context and continuity.
Refer back when natural, do NOT contradict anything in them, do NOT repeat
their content verbatim. Write in language "${lang}" the same as them.

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

${spaceContextBlock(spaceSources, spaceLinks, lang, spaceStrict, spaceDirs)}${categoryBlock}${memoryBlock}${prevArticlesBlock(previousArticles, lang)}You are writing this specific submodule:
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
or any other text/code artifact — do NOT use image or gallery widgets: a
searched or generated picture of these is meaningless or hallucinated. Instead,
write a concrete, self-authored example INLINE as a real Markdown fenced code
block — invent a representative snippet rather than searching for or generating
one as an image. Reserve image/gallery widgets for genuinely visual subjects
(real photographs, real UI screenshots found via search, real diagrams/charts
of real data, physical objects).

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

INTERACTIVE WIDGETS: small self-contained HTML+CSS+JS that runs in a
sandboxed iframe (no network, no cookies, no parent access). Use 0-2 per
submodule, only when interactivity meaningfully aids comprehension —
examples that fit well:
  • algorithm step-through with Prev/Next buttons (sorting, search)
  • fill-in-the-blank card with check-answer feedback
  • multiple-choice flashcard with explanation reveal
  • slider that animates or recomputes a derived value
  • drag-to-match pairs

Hard rules — your widget WILL BE REJECTED if it breaks any of these:
  • Vanilla JS only. No frameworks, no <script src=…>, no imports, no eval,
    no new Function, no fetch, no XMLHttpRequest.
  • No reading/writing localStorage/sessionStorage/cookies.
  • No accessing window.parent / window.top.
  • Total html + css + js ≤ 8000 characters.
  • All assets inline (use only DOM, addEventListener, requestAnimationFrame,
    setTimeout, Math, etc.).
  • Adapt to dark mode via @media (prefers-color-scheme: dark) in your CSS.

Provide:
  - "html": body content only (NO <html>/<head>/<body> tags — UI wraps them).
  - "css": stylesheet rules (will go into a <style> tag).
  - "js": script code (will go into a <script> tag at end of body).
  - "title": short label in ${lang}.
  - "description": one or two sentences in ${lang} explaining what the
    learner can do with this widget.
  - "height": integer pixels, clamp 160-640. Pick a reasonable default
    based on content (compact card ~220, animation canvas ~360).

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
Research efficiently: a few targeted lookups (about 3-4 web calls total),
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
- video: {"id":"vid-1","type":"video","url":"<youtube/vimeo watch url>","title":"<video title>","recommended_by":"<url of the recommendation source>","why":"<one-sentence reason in ${lang}>"}
- interactive: {"id":"int-1","type":"interactive","title":"<short label in ${lang}>","description":"<1-2 sentences in ${lang}>","html":"<body content>","css":"<stylesheet>","js":"<script>","height":320}

Each source object: {"title":"<page title>","url":"<url>"}
If no widgets, use []. If no sources, use [].`;
  onProgress?.({ label: "thinking" });
  const text = await runStreamed(prompt, onProgress, {
    web: true,
    braveApiKey,
    modelConfig,
    dirs: spaceDirs,
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
      out[id] = {
        type: "video",
        url,
        title: typeof w.title === "string" ? w.title.trim() : "",
        recommended_by:
          typeof w.recommended_by === "string" ? w.recommended_by.trim() : "",
        why: typeof w.why === "string" ? w.why.trim() : "",
      };
    } else if (w.type === "interactive") {
      out[id] = {
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
  schema, a JSON or config payload, command output, or logs — where a searched
  or generated picture would be meaningless or hallucinated. Do NOT add an image
  here; instead write a concrete, self-authored Markdown fenced code block
  INLINE right where it helps (invent a representative snippet).
Be friendly to illustration count on genuinely visual subjects: several precise
illustrations beat one token image. Do not decorate every paragraph, and do not
add a snippet where the prose already shows one.

Rules:
- Preserve all existing widget marker lines and existing ids.
- Add at most 6 NEW image/gallery widgets total.
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
5. Light polish for flow — do NOT rewrite the voice or restructure.

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
    } else if (w?.type === "interactive") {
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
- Follow the chosen generation format exactly for module/submodule counts and tone.
- All titles and summaries in language "${lang}".

${languageStyleGuide(lang)}

Also classify this course into exactly ONE category id from this fixed list
(pick the single best fit; use "general" only when nothing else clearly fits):
${categoryClassifyGuide()}

Output ONLY a JSON object on a single line, no prose, no markdown fence.
Shape:
{"category":"<one id from the list above>","title":"...","modules":[{"title":"...","summary":"...","submodules":[{"title":"...","summary":"..."}]}]}`;
  const text = await runStreamed(prompt, ctx?.progress, {
    web: true,
    modelConfig,
    dirs: spaceDirs,
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

${articleBlock}${fragBlock}${histBlock}Learner's question: ${question}

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
    for await (const m of query({
      prompt: userPrompt(),
      options: { maxTurns: 4, ...claudeBaseOptions(modelOptions(modelConfig)) },
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

export async function generateTest({ topic, language, courseFormat, submodulePath, article, modelConfig }, ctx) {
  if (normalizeCourseFormat(courseFormat) === "podcast_series") {
    return { questions: [] };
  }
  if (typeof article !== "string" || !article.trim()) {
    throw new Error("article required for test generation");
  }
  const lang = (language || "en").trim();
  const prompt = `You are writing a short comprehension test for a submodule of
a course on "${topic}" (language: ${lang}).

${courseFormatGuide(courseFormat, lang)}

Submodule: ${submodulePath?.title || ""}${submodulePath?.summary ? ` — ${submodulePath.summary}` : ""}

Article the test must be based on:
<article>
${article}
</article>

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

// ── Homework assignments ────────────────────────────────────────────────────

const ASSIGNMENT_TYPES = ["image", "text", "document", "archive", "github"];
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
export async function generateAssignments({ topic, language, courseFormat, submodulePath, article, modelConfig }, ctx) {
  if (normalizeCourseFormat(courseFormat) === "podcast_series") {
    return { assignments: [] };
  }
  if (typeof article !== "string" || !article.trim()) {
    throw new Error("article required for assignment generation");
  }
  const lang = (language || "en").trim();
  const prompt = `You are designing practical homework for one submodule of a
course on "${topic}" (language: ${lang}).

${courseFormatGuide(courseFormat, lang)}

Submodule: ${submodulePath?.title || ""}${submodulePath?.summary ? ` — ${submodulePath.summary}` : ""}

The article the learner just studied:
<article>
${article}
</article>

Design a SHORT CHAIN of 1-3 practical assignments that make the learner APPLY
what they learned, ordered as a progression (each builds on the previous).
For each assignment pick the single best submission type:
- "image"    — the learner produces a drawing/sketch/diagram/photo (e.g. "draw a
               cube in two-point perspective"). Best for visual/art/design skills.
- "text"     — a written answer, analysis, or short essay submitted as text.
- "document" — the learner uploads a file (report, notes, PDF, spreadsheet).
- "archive"  — the learner uploads a .zip of a small program/project.
- "github"   — the learner submits a link to a GitHub repository.
Match the type to the skill: drawing→image, writing/analysis→text,
coding→archive or github, longer deliverables→document.

For each assignment write clear "criteria" — the concrete, checkable things a
reviewer grades against (this drives an iterative review-and-revise loop).
Tasks must be concrete and achievable from the article; no busywork.
All text in language "${lang}".

${languageStyleGuide(lang)}

Output ONLY a JSON object on a single line, no prose, no markdown fence:
{"assignments":[{"title":"...","prompt":"...","type":"image|text|document|archive|github","criteria":"..."}]}`;
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
${histBlock}Now review the learner's NEW submission below.${imageNote}${githubBlock}${textBlock}

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

export async function wizardQuestions({ topic, language, courseFormat, modelConfig }, ctx) {
  if (typeof topic !== "string" || !topic.trim()) {
    throw new Error("topic must be a non-empty string");
  }
  const lang = (language || "en").trim();
  const prompt = `You are designing a personalized course on "${topic}".
The course will be delivered in language code "${lang}".

${courseFormatGuide(courseFormat, lang)}

Generate 5-10 clarifying questions to ask the learner BEFORE you build the
curriculum. The questions should uncover the things that most change how a
good program for this specific person would look: prior knowledge, concrete
goals, available time, constraints, tools/materials, preferred depth, and
anything topic-specific that matters. Skip pleasantries.
Do not ask the learner to choose the generation format again.
${wizardQuestionGuide(courseFormat, lang)}

For EACH question, also provide 3-5 realistic, mutually-distinct answer
options the learner can pick from. The options should:
- cover the common cases for this topic (not generic "low/medium/high");
- be concrete and topic-specific (e.g. for painting: "масло", "акварель",
  "карандаш и уголь" — not "art supplies");
- be short (a phrase, not a paragraph);
- be in language "${lang}".

For EACH question, also decide whether multiple options can be picked at once.
Set "multi": true by default — most questions about preferences, scopes,
materials, goals, formats naturally accept several answers (e.g. "Какие
жанры интересны?" — портрет AND пейзаж; "Какими материалами работаете?" —
масло AND акварель). Set "multi": false ONLY when answers are genuinely
mutually exclusive (e.g. "Сколько часов в неделю готовы уделять?",
"Какой у вас текущий уровень?", "Это для работы или для хобби?"). When in
doubt, use multi — forcing a single choice when several apply frustrates
the learner.

The user will also have a free-text fallback for both modes, so do NOT add
an "other" option.

Also generate a short display title for the whole course. It must NOT copy the
learner's raw request verbatim. Make it a concise noun phrase, 2-6 words,
written in language "${lang}", with no quotes and no "course about/on" wrapper.

Write everything in language "${lang}".

${languageStyleGuide(lang)}

Output ONLY a JSON object on a single line, no prose, no markdown fence.
Shape: {"title":"...","questions":[{"text":"...","options":["...","..."],"multi":true}]}`;
  const text = await runStreamed(prompt, ctx?.progress, { modelConfig });
  const parsed = extractJson(text);
  if (!Array.isArray(parsed?.questions)) {
    throw new Error("LLM response missing 'questions' array");
  }
  const questions = parsed.questions
    .map((q) => {
      if (!q || typeof q.text !== "string") return null;
      const text = q.text.trim();
      if (!text) return null;
      const options = Array.isArray(q.options)
        ? q.options
            .filter((o) => typeof o === "string" && o.trim().length > 0)
            .map((o) => o.trim())
        : [];
      // Default to multi when unspecified — multi-select is the wizard norm.
      const multi = q.multi !== false;
      return { text, options, multi };
    })
    .filter(Boolean);
  if (questions.length === 0) throw new Error("LLM returned zero valid questions");
  return { title: normalizeCourseTitle(parsed?.title), questions };
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

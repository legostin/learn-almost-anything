// Claude Agent SDK wrapper.
//
// Subscription auth: when ANTHROPIC_API_KEY is unset, the SDK uses the local
// `claude` CLI auth (Claude Pro/Max subscription). The Rust side strips
// ANTHROPIC_API_KEY from the spawned env to guarantee subscription billing.

import { readFileSync } from "node:fs";

import { query } from "@anthropic-ai/claude-agent-sdk";

import { repairPrompt, validateInteractive } from "../lib/interactive.mjs";

function terminologyGuide(lang) {
  return `Use the terminology that practitioners in this field actually use in language "${lang}". Prefer established loan words and idiomatic terms over literal translations (e.g. for programming in Russian: "легаси-код", not "наследие-код"; "деплой" / "deploy", not "развёртывание"; "merge request", not "запрос на слияние"). The exact vocabulary depends on the domain — match the register of how professionals in this field actually speak and write.`;
}

async function runOnce(prompt) {
  return await runStreamed(prompt);
}

// Builds Claude Agent SDK options. When braveApiKey is provided, spawns the
// official Brave Search MCP server as a stdio subprocess and whitelists its
// tools. Without a key the agent runs without Brave (no web search).
function buildClaudeOptions({ maxTurns, braveApiKey } = {}) {
  const options = { maxTurns: maxTurns ?? 1 };
  if (braveApiKey) {
    options.mcpServers = {
      brave: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-brave-search"],
        env: { BRAVE_API_KEY: braveApiKey },
      },
    };
    options.allowedTools = [
      "mcp__brave__brave_web_search",
      "mcp__brave__brave_image_search",
    ];
  }
  return options;
}

async function runStreamed(prompt, onProgress, opts) {
  let text = "";
  // When Brave MCP is available, the agent may take several turns (search,
  // read, write). Without tools, one turn is enough.
  const options = buildClaudeOptions({
    maxTurns: opts?.braveApiKey ? 8 : 1,
    braveApiKey: opts?.braveApiKey,
  });
  for await (const message of query({ prompt, options })) {
    if (message.type === "assistant") {
      const content = message.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === "text" && block.text) {
            const tail = block.text.replace(/\s+/g, " ").trim().slice(-100);
            if (tail && onProgress) onProgress({ label: "writing", detail: tail });
          } else if (block?.type === "tool_use" && block.name && onProgress) {
            // Surface tool calls in progress (e.g. brave_web_search query).
            const q =
              block.input && typeof block.input.query === "string"
                ? block.input.query
                : "";
            const label = block.name.includes("image") ? "searching images" : "searching";
            onProgress({ label, detail: q || block.name });
          }
        }
      }
    } else if (message.type === "result" && message.subtype === "success") {
      text = message.result;
    }
  }
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
    courseMd,
    structure,
    memoryFiles,
    modulePath,
    submodulePath,
    previousArticles,
    braveApiKey,
  },
  onProgress
) {
  const lang = (language || "en").trim();
  const memoryBlock =
    memoryFiles && memoryFiles.length
      ? `Past user feedback (apply to tone and content):\n${memoryFiles
          .map((f) => `--- ${f.filename} ---\n${f.content}`)
          .join("\n\n")}\n\n`
      : "";
  const prompt = `You are writing one submodule of a personalized course on
"${topic}" (language: ${lang}).

Course brief (wizard Q&A):
<course-md>
${courseMd}
</course-md>

Full curriculum (for context — do not repeat other modules):
<structure>
${JSON.stringify(structure, null, 2)}
</structure>

${memoryBlock}${prevArticlesBlock(previousArticles, lang)}You are writing this specific submodule:
- Parent module: ${modulePath.title}${modulePath.summary ? ` — ${modulePath.summary}` : ""}
- This submodule: ${submodulePath.title}${submodulePath.summary ? ` — ${submodulePath.summary}` : ""}

Write a detailed, engaging article in language "${lang}". ~600-1200 words.
Use Markdown headings (## / ###), short paragraphs, and concrete examples
specific to this learner (not generic textbook prose). Do not repeat the
overall course intro — assume the learner has the curriculum in front of them.
When relevant, reference what was established in earlier submodules to build
continuity. Never contradict them.

You may add visual-aid widgets where they meaningfully help. Mark insertion
points with a single line, alone, with blank lines above and below:

  ::widget{type="image" id="img-1"}        (real-world photo or illustration)
  ::widget{type="diagram" id="diag-1"}     (a Mermaid-rendered diagram)
  ::widget{type="video" id="vid-1"}        (an embedded video — see below)
  ::widget{type="interactive" id="int-1"}  (a tiny self-contained mini-app — see below)

Use 0-4 widgets total — skip them if the topic is purely textual prose.
Diagrams are great for processes, hierarchies, state machines, sequences,
component relations. Use Mermaid syntax (flowchart TD, sequenceDiagram, etc.).

VIDEO WIDGETS: only include a video if you find one that is RECOMMENDED by
real people elsewhere — a Reddit/forum thread that calls it out, a "best
videos on X" listicle, a blog post that says "watch this", a course
syllabus that links it. NEVER pick a video purely by its YouTube title or
search rank. Record the recommendation source in "recommended_by". If you
can't find a recommended one, skip the video — better none than a random.

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

${
  braveApiKey
    ? `You have web access through the Brave Search MCP tools:
- mcp__brave__brave_web_search — use it to verify facts, find concrete
  examples, current best practices, and citations. For videos, search
  things like "best youtube videos to learn X reddit", "<topic>
  recommended video tutorials site:reddit.com", "<topic> video
  recommendations forum" — find videos others suggest, not whatever
  ranks first.
- mcp__brave__brave_image_search — find REAL image URLs for image
  widgets. When you find a good one, set "url" to the direct image URL
  and "source" to the page url. If nothing fits, leave url empty —
  the UI will show a placeholder + your description.

Use search liberally during research, but write the article in your own
voice. Don't quote large blocks; weave findings in naturally. Only put
a fact in the article if you actually have a source backing it.
`
    : ""
}

SOURCES: at the end, return a "sources" array listing every URL you
ACTUALLY consulted while writing this submodule. Be honest — do not
invent URLs, do not include sources you didn't read. If you wrote
entirely from your own knowledge with no web lookups, return [].

${terminologyGuide(lang)}

Output ONLY a JSON object on a single line, no prose, no markdown fence:
{"article":"<markdown with widget markers>","widgets":[<widget objects>],"sources":[<source objects>]}

Each widget object:
- image: {"id":"img-1","type":"image","description":"<what to depict, in ${lang}>","alt":"<short alt in ${lang}>","url":"<direct image url or empty>","source":"<page url or empty>"}
- diagram: {"id":"diag-1","type":"diagram","source":"<mermaid source>","caption":"<short caption in ${lang}>"}
- video: {"id":"vid-1","type":"video","url":"<youtube/vimeo watch url>","title":"<video title>","recommended_by":"<url of the recommendation source>","why":"<one-sentence reason in ${lang}>"}
- interactive: {"id":"int-1","type":"interactive","title":"<short label in ${lang}>","description":"<1-2 sentences in ${lang}>","html":"<body content>","css":"<stylesheet>","js":"<script>","height":320}

Each source object: {"title":"<page title>","url":"<url>"}
If no widgets, use []. If no sources, use [].`;
  onProgress?.({ label: "thinking" });
  const text = await runStreamed(prompt, onProgress, { braveApiKey });
  const parsed = extractJson(text);
  if (!parsed?.article || typeof parsed.article !== "string") {
    throw new Error("LLM returned no article");
  }
  return {
    article: parsed.article.trim(),
    widgets: normalizeWidgets(parsed.widgets),
    sources: normalizeSources(parsed.sources),
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
        description: typeof w.description === "string" ? w.description.trim() : "",
        alt: typeof w.alt === "string" ? w.alt.trim() : "",
        ...(url ? { url } : {}),
        ...(typeof w.source === "string" && w.source.trim()
          ? { source: w.source.trim() }
          : {}),
      };
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
  { article, language, topic, previousArticles },
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

${terminologyGuide(lang)}

Output ONLY a JSON object on a single line:
{"article":"<full revised article markdown>","notes":"<1-3 sentences describing what you fixed; empty string if nothing>"}`;
  onProgress?.({ label: "reviewing" });
  const text = await runStreamed(prompt, onProgress);
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

async function validateWidgets({ article, widgets }, onProgress) {
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
        onProgress
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

async function validateAndRepairInteractive(widget, id, onProgress) {
  let current = widget;
  let lastError = await validateInteractive(current);
  if (!lastError) return { final: current, error: null, repairs: 0 };

  onProgress?.({ label: "validating", detail: `${id}: ${lastError}` });

  for (let attempt = 1; attempt <= INTERACTIVE_MAX_REPAIRS; attempt++) {
    onProgress?.({
      label: "validating",
      detail: `${id}: repair ${attempt}/${INTERACTIVE_MAX_REPAIRS}`,
    });
    let repaired;
    try {
      repaired = await repairInteractive(current, lastError);
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
    if (!lastError) return { final: current, error: null, repairs: attempt };
    onProgress?.({ label: "validating", detail: `${id}: ${lastError}` });
  }
  return { final: current, error: lastError, repairs: INTERACTIVE_MAX_REPAIRS };
}

async function repairInteractive(widget, errorMsg) {
  const prompt = repairPrompt(widget, errorMsg);
  const text = await runStreamed(prompt);
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
  const s = (source || "").trim();
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
  // Roughly balanced brackets — catches truncated output.
  const counts = (re) => (s.match(re) || []).length;
  if (counts(/\[/g) !== counts(/\]/g)) return "unbalanced square brackets";
  if (counts(/\{/g) !== counts(/\}/g)) return "unbalanced curly brackets";
  if (counts(/\(/g) !== counts(/\)/g)) return "unbalanced parentheses";
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
FULL tree (4-10 top-level modules × 2-6 submodules), not a diff.

${terminologyGuide(lang)}`;
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
 * @param {{topic:string, language:string, courseMd:string, currentStructure:object, memoryFiles:{filename:string,content:string}[], chatHistory:{role:string,text:string}[], userMessage:string}} params
 * @returns {Promise<{reply:string, modules: Array<{title:string, summary:string, submodules:{title:string,summary:string}[]}>}>}
 */
export async function refineStructure(params) {
  if (typeof params?.userMessage !== "string" || !params.userMessage.trim()) {
    throw new Error("userMessage must be a non-empty string");
  }
  const prompt = buildRefinePrompt(params);
  const text = await runOnce(prompt);
  const parsed = extractJson(text);
  return normalizeRefineResponse(parsed);
}

/**
 * Build a curriculum tree from the course.md (topic + wizard answers).
 * @param {{ courseMd: string, topic: string, language: string }} params
 * @returns {Promise<{ modules: Array<{ title: string, summary?: string, submodules: Array<{ title: string, summary?: string }> }> }>}
 */
export async function buildStructure({ courseMd, topic, language }) {
  if (typeof topic !== "string" || !topic.trim()) {
    throw new Error("topic must be a non-empty string");
  }
  if (typeof courseMd !== "string" || !courseMd.trim()) {
    throw new Error("courseMd must be a non-empty string");
  }
  const lang = (language || "en").trim();
  const prompt = `You are designing a personalized course on "${topic}".
The course will be delivered in language code "${lang}".

Below is the course brief — a markdown file with the wizard Q&A.

<course-md>
${courseMd}
</course-md>

Design a curriculum: a list of top-level modules, each with a few submodules.

Research first. Before sketching anything, look up how this subject is taught
in serious places: university programs (especially the best ones —
top art academies, top engineering schools, etc. as relevant), well-regarded
online courses, established certifications, and the canonical reading paths
practitioners recommend. Use the convergence of those programs as your skeleton.
If multiple traditions exist (e.g. русская академическая vs European atelier),
acknowledge them and pick the one that best fits the learner's goals from the
brief. Never improvise a structure from intuition when established programs
exist.

Constraints:
- Reflect the learner's specific goals, prior knowledge, and constraints from the brief.
- Skip modules irrelevant to those goals; do not produce a generic textbook outline.
- Use 4-10 top-level modules; each with 2-6 submodules.
- All titles and summaries in language "${lang}".

${terminologyGuide(lang)}

Output ONLY a JSON object on a single line, no prose, no markdown fence.
Shape:
{"modules":[{"title":"...","summary":"...","submodules":[{"title":"...","summary":"..."}]}]}`;
  const text = await runOnce(prompt);
  const parsed = extractJson(text);
  if (!Array.isArray(parsed?.modules) || parsed.modules.length === 0) {
    throw new Error("LLM response missing non-empty 'modules' array");
  }
  const modules = parsed.modules.map((m) => {
    if (typeof m?.title !== "string" || !m.title.trim()) {
      throw new Error("module missing title");
    }
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
  return { modules };
}

/**
 * Generate clarifying questions for a course topic, in the course's language.
 * Each question has a small set of realistic answer options.
 * @param {{ topic: string, language: string }} params
 * @returns {Promise<{ questions: Array<{ text: string, options: string[] }> }>}
 */
/**
 * Generate a multiple-choice test for a submodule, based on its article.
 * @param {{topic:string, language:string, submodulePath:{title:string,summary:string}, article:string}} params
 * @returns {Promise<{questions: Array<{text:string, options:string[], correct:number, explanation:string}>}>}
 */
export async function generateTest({ topic, language, submodulePath, article }, ctx) {
  if (typeof article !== "string" || !article.trim()) {
    throw new Error("article required for test generation");
  }
  const lang = (language || "en").trim();
  const prompt = `You are writing a short comprehension test for a submodule of
a course on "${topic}" (language: ${lang}).

Submodule: ${submodulePath?.title || ""}${submodulePath?.summary ? ` — ${submodulePath.summary}` : ""}

Article the test must be based on:
<article>
${article}
</article>

Write 5-8 multiple-choice questions that check real UNDERSTANDING of this
article — not trivia or verbatim recall. Each question:
- has 3-5 plausible options, exactly ONE correct;
- "correct" is the 0-based index of the right option;
- includes a one-sentence "explanation" of why the answer is right;
- is written in language "${lang}".

${terminologyGuide(lang)}

Output ONLY a JSON object on a single line, no prose, no markdown fence:
{"questions":[{"text":"...","options":["...","..."],"correct":0,"explanation":"..."}]}`;
  ctx?.progress?.({ label: "thinking" });
  const text = await runStreamed(prompt, ctx?.progress);
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
      return {
        text: q.text.trim(),
        options,
        correct,
        explanation: typeof q.explanation === "string" ? q.explanation.trim() : "",
      };
    })
    .filter(Boolean);
}

/**
 * Vision review of candidate images for one image-widget slot.
 * @param {{language:string, description:string, alt:string, topic:string, candidates:{path:string}[]}} params
 * @returns {Promise<{pick: number|null, reason: string, refinedQuery: string}>}
 */
export async function reviewImages(params, ctx) {
  const { language, description, alt, topic, candidates } = params;
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
    options: { maxTurns: 1 },
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

export async function wizardQuestions({ topic, language }) {
  if (typeof topic !== "string" || !topic.trim()) {
    throw new Error("topic must be a non-empty string");
  }
  const lang = (language || "en").trim();
  const prompt = `You are designing a personalized course on "${topic}".
The course will be delivered in language code "${lang}".

Generate 5-10 clarifying questions to ask the learner BEFORE you build the
curriculum. The questions should uncover the things that most change how a
good program for this specific person would look: prior knowledge, concrete
goals, available time, constraints, tools/materials, preferred depth, and
anything topic-specific that matters. Skip pleasantries.

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

Write everything in language "${lang}".

${terminologyGuide(lang)}

Output ONLY a JSON object on a single line, no prose, no markdown fence.
Shape: {"questions":[{"text":"...","options":["...","..."],"multi":true}]}`;
  const text = await runOnce(prompt);
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
  return { questions };
}

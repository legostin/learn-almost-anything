// Codex SDK wrapper.
//
// The SDK shells out to the local `codex` CLI binary, which authenticates via
// `codex login` (ChatGPT subscription). When `apiKey` is not provided, the SDK
// uses whatever auth the local CLI has configured — same subscription pattern
// as the Claude side.

import { Codex } from "@openai/codex-sdk";

// Codex SDK takes config overrides via constructor; we make a fresh
// instance per call when Brave MCP is needed so the key isn't held in
// long-lived state. Without a key, falls back to a shared instance.
function makeCodex(braveApiKey) {
  if (!braveApiKey) return defaultCodex;
  return new Codex({
    config: {
      mcp_servers: {
        brave: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-brave-search"],
          env: { BRAVE_API_KEY: braveApiKey },
        },
      },
    },
  });
}

const defaultCodex = new Codex();

function terminologyGuide(lang) {
  return `Use the terminology that practitioners in this field actually use in language "${lang}". Prefer established loan words and idiomatic terms over literal translations (e.g. for programming in Russian: "легаси-код", not "наследие-код"; "деплой" / "deploy", not "развёртывание"; "merge request", not "запрос на слияние"). The exact vocabulary depends on the domain — match the register of how professionals in this field actually speak and write.`;
}

const baseThreadOptions = {
  // We're not in a git repo at the user's course-data dir, and we don't want
  // codex to refuse to run for that reason.
  skipGitRepoCheck: true,
  // No filesystem mutation during these turns.
  sandboxMode: "read-only",
  networkAccessEnabled: true,
  webSearchEnabled: true,
};

async function runOnce(prompt, outputSchema, opts) {
  const thread = makeCodex(opts?.braveApiKey).startThread(baseThreadOptions);
  const turn = await thread.run(prompt, outputSchema ? { outputSchema } : undefined);
  return turn.finalResponse;
}

async function runStreamed(prompt, outputSchema, onProgress, opts) {
  if (!onProgress) return await runOnce(prompt, outputSchema, opts);
  const thread = makeCodex(opts?.braveApiKey).startThread(baseThreadOptions);
  const stream = await thread.runStreamed(
    prompt,
    outputSchema ? { outputSchema } : undefined
  );
  let final = "";
  for await (const ev of stream.events) {
    if (ev.type === "item.started" || ev.type === "item.updated") {
      const item = ev.item;
      if (!item) continue;
      if (item.type === "web_search" && item.query) {
        onProgress({ label: "searching", detail: item.query });
      } else if (item.type === "reasoning" && typeof item.text === "string" && item.text.trim()) {
        const tail = item.text.replace(/\s+/g, " ").trim().slice(-100);
        onProgress({ label: "thinking", detail: tail });
      } else if (
        item.type === "agent_message" &&
        typeof item.text === "string" &&
        item.text.trim()
      ) {
        const tail = item.text.replace(/\s+/g, " ").trim().slice(-100);
        onProgress({ label: "writing", detail: tail });
      } else if (item.type === "command_execution" && item.command) {
        onProgress({ label: "running", detail: String(item.command).slice(0, 100) });
      }
    } else if (ev.type === "item.completed") {
      const item = ev.item;
      if (item?.type === "agent_message" && typeof item.text === "string") {
        final = item.text;
      }
    } else if (ev.type === "error") {
      throw new Error(ev.message || "codex stream error");
    }
  }
  return final;
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

/**
 * @param {{ topic: string, language: string }} params
 */
export async function wizardQuestions({ topic, language }) {
  if (typeof topic !== "string" || !topic.trim()) {
    throw new Error("topic must be a non-empty string");
  }
  const lang = (language || "en").trim();
  const prompt = `You are designing a personalized course on "${topic}".
The course will be delivered in language code "${lang}".

Generate 5-10 clarifying questions to ask the learner BEFORE you build the
curriculum. Each question must have 3-5 short, mutually-distinct, concrete,
topic-specific answer options the learner can pick from. The user will also
have a free-text fallback so do NOT add an "other" option.

For EACH question, set "multi": true by default — most questions about
preferences, scopes, materials, goals, formats naturally accept several
answers (e.g. "Какие жанры интересны?" — портрет AND пейзаж; "Какими
материалами работаете?" — масло AND акварель). Set "multi": false ONLY when
answers are genuinely mutually exclusive (e.g. "Сколько часов в неделю
готовы уделять?", "Какой у вас текущий уровень?", "Это для работы или
для хобби?"). When in doubt, use multi — forcing a single choice when
several apply frustrates the learner.

Write everything in language "${lang}".

${terminologyGuide(lang)}`;

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      questions: {
        type: "array",
        minItems: 5,
        maxItems: 10,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: { type: "string" },
            options: {
              type: "array",
              minItems: 3,
              maxItems: 5,
              items: { type: "string" },
            },
            multi: { type: "boolean" },
          },
          required: ["text", "options", "multi"],
        },
      },
    },
    required: ["questions"],
  };

  const text = await runOnce(prompt, schema);
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed?.questions)) {
    throw new Error("Codex response missing 'questions' array");
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
  if (questions.length === 0) throw new Error("Codex returned zero valid questions");
  return { questions };
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

/**
 * Vision review of candidate images for one image-widget slot.
 * @param {{language:string, description:string, alt:string, topic:string, candidates:{path:string}[], braveApiKey?:string}} params
 * @returns {Promise<{pick: number|null, reason: string, refinedQuery: string}>}
 */
export async function reviewImages(params, ctx) {
  const { language, description, alt, topic, candidates, braveApiKey } = params;
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
  const thread = makeCodex(braveApiKey).startThread(baseThreadOptions);
  const turn = await thread.run(input);
  const parsed = extractJsonLoose(turn.finalResponse);
  return {
    pick: typeof parsed.pick === "number" ? parsed.pick : null,
    reason: typeof parsed.reason === "string" ? parsed.reason : "",
    refinedQuery: typeof parsed.refinedQuery === "string" ? parsed.refinedQuery : "",
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
    imageWidgets: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          description: { type: "string" },
          alt: { type: "string" },
          url: { type: "string" },
          source: { type: "string" },
        },
        required: ["id", "description", "alt", "url", "source"],
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
  },
  required: ["article", "imageWidgets", "diagramWidgets"],
};

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

  ::widget{type="image" id="img-1"}      (real-world photo or illustration)
  ::widget{type="diagram" id="diag-1"}   (a Mermaid-rendered diagram)

Use 0-4 widgets total — skip them if the topic is purely textual prose.
Diagrams are great for processes, hierarchies, state machines, sequences,
component relations. Use Mermaid syntax (flowchart TD, sequenceDiagram, etc.).

Return widgets in two separate arrays:
- imageWidgets: [{id, description (in ${lang}), alt (in ${lang}), url (direct image url or ""), source (page url or "")}]
- diagramWidgets: [{id, source (Mermaid source), caption (in ${lang})}]

If a category is unused, return an empty array [].

${
  braveApiKey
    ? `You have web access through the Brave Search MCP tools:
- mcp__brave__brave_web_search — for verifying facts, finding concrete
  examples, current best practices, and citations.
- mcp__brave__brave_image_search — for finding REAL image URLs for image
  widgets. When you find a good one, set the image widget's "url" field
  to the direct image URL and "source" to the page url. If you can't
  find a suitable image, leave both as "" and the UI will show a
  placeholder with the description.

Codex's built-in web search is also available — use whichever fits.
`
    : `Use Codex's built-in web search where useful to verify facts and
find concrete examples. For image widgets, leave url and source as ""
unless you have a confidently-correct direct image URL.
`
}
${terminologyGuide(lang)}`;
  onProgress?.({ label: "thinking" });
  const text = await runStreamed(prompt, draftSchema, onProgress, { braveApiKey });
  const parsed = JSON.parse(text);
  if (!parsed?.article || typeof parsed.article !== "string") {
    throw new Error("Codex returned no article");
  }
  return {
    article: parsed.article.trim(),
    widgets: mergeWidgets(parsed.imageWidgets, parsed.diagramWidgets),
  };
}

function mergeWidgets(imageWidgets, diagramWidgets) {
  const out = {};
  if (Array.isArray(imageWidgets)) {
    for (const w of imageWidgets) {
      if (w && typeof w.id === "string" && w.id.trim()) {
        const url = typeof w.url === "string" ? w.url.trim() : "";
        out[w.id.trim()] = {
          type: "image",
          placeholder: !url,
          description: typeof w.description === "string" ? w.description.trim() : "",
          alt: typeof w.alt === "string" ? w.alt.trim() : "",
          ...(url ? { url } : {}),
          ...(typeof w.source === "string" && w.source.trim()
            ? { source: w.source.trim() }
            : {}),
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
  return out;
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
3. Factual claims — verify them (use web search). If something is wrong,
   fix it. If you cannot verify and the claim carries weight, soften the
   language or remove the unsubstantiated bit.
4. Internal consistency — check this article against the previous submodules
   shown below. If there are contradictions (terminology, facts, level
   assumptions, etc.), resolve them in favor of what's already established.
5. Light polish for flow — do NOT rewrite the voice or restructure.

${prevArticlesBlock(previousArticles, lang)}Article to review:
<article>
${article}
</article>

${terminologyGuide(lang)}

Return the full revised article in "article" and a brief log of fixes in
"notes" (empty string if nothing changed materially).`;
  onProgress?.({ label: "reviewing" });
  const text = await runStreamed(prompt, reviewSchema, onProgress);
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
  let bad = 0;
  let checked = 0;
  for (const [id, w] of Object.entries(widgets)) {
    if (w?.type === "diagram") {
      checked++;
      const issue = mermaidIssue(w.source);
      if (issue) {
        bad++;
        out[id] = { ...w, error: issue };
        ctx?.progress?.({ label: "validating", detail: `${id}: ${issue}` });
      } else {
        out[id] = w;
      }
    } else {
      out[id] = w;
    }
  }
  const notes = bad > 0 ? `Mermaid validation: ${bad}/${checked} diagram(s) flagged.` : "";
  return { article: params.article, widgets: out, notes };
}

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
  const counts = (re) => (s.match(re) || []).length;
  if (counts(/\[/g) !== counts(/\]/g)) return "unbalanced square brackets";
  if (counts(/\{/g) !== counts(/\}/g)) return "unbalanced curly brackets";
  if (counts(/\(/g) !== counts(/\)/g)) return "unbalanced parentheses";
  return null;
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
 * @param {{topic:string, language:string, courseMd:string, currentStructure:object, memoryFiles:{filename:string,content:string}[], chatHistory:{role:string,text:string}[], userMessage:string}} params
 */
export async function refineStructure(params) {
  if (typeof params?.userMessage !== "string" || !params.userMessage.trim()) {
    throw new Error("userMessage must be a non-empty string");
  }
  const prompt = buildRefinePrompt(params);
  const text = await runOnce(prompt, refineSchema);
  const parsed = JSON.parse(text);
  return normalizeRefineResponse(parsed);
}

/**
 * @param {{ courseMd: string, topic: string, language: string }} params
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

Research first. Before sketching anything, web-search how this subject is
taught in serious places: university programs (especially the best ones —
top art academies, top engineering schools, etc. as relevant), well-regarded
online courses, established certifications, and the canonical reading paths
practitioners recommend. Use the convergence of those programs as your skeleton.
If multiple traditions exist (e.g. русская академическая vs European atelier),
acknowledge them and pick the one that best fits the learner's goals from the
brief. Never improvise a structure from intuition when established programs
exist.

Constraints:
- Reflect the learner's specific goals, prior knowledge, and constraints.
- Skip modules irrelevant to those goals; do not produce a generic textbook.
- 4-10 top-level modules; each with 2-6 submodules.
- All titles and summaries in language "${lang}".

${terminologyGuide(lang)}`;

  const submoduleSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      title: { type: "string" },
      summary: { type: "string" },
    },
    required: ["title", "summary"],
  };

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
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
    required: ["modules"],
  };

  const text = await runOnce(prompt, schema);
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed?.modules) || parsed.modules.length === 0) {
    throw new Error("Codex response missing non-empty 'modules' array");
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

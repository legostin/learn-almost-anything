// Codex SDK wrapper.
//
// The SDK shells out to the local `codex` CLI binary, which authenticates via
// `codex login` (ChatGPT subscription). When `apiKey` is not provided, the SDK
// uses whatever auth the local CLI has configured — same subscription pattern
// as the Claude side.

import { Codex } from "@openai/codex-sdk";

function terminologyGuide(lang) {
  return `Use the terminology that practitioners in this field actually use in language "${lang}". Prefer established loan words and idiomatic terms over literal translations (e.g. for programming in Russian: "легаси-код", not "наследие-код"; "деплой" / "deploy", not "развёртывание"; "merge request", not "запрос на слияние"). The exact vocabulary depends on the domain — match the register of how professionals in this field actually speak and write.`;
}

const codex = new Codex();

const baseThreadOptions = {
  // We're not in a git repo at the user's course-data dir, and we don't want
  // codex to refuse to run for that reason.
  skipGitRepoCheck: true,
  // No filesystem mutation during these turns.
  sandboxMode: "read-only",
  networkAccessEnabled: true,
  webSearchEnabled: true,
};

async function runOnce(prompt, outputSchema) {
  const thread = codex.startThread(baseThreadOptions);
  const turn = await thread.run(prompt, outputSchema ? { outputSchema } : undefined);
  return turn.finalResponse;
}

async function runStreamed(prompt, outputSchema, onProgress) {
  if (!onProgress) return await runOnce(prompt, outputSchema);
  const thread = codex.startThread(baseThreadOptions);
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
          },
          required: ["text", "options"],
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
      return { text, options };
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

/** Stage 1 — draft a fresh article. */
export async function submoduleDraft(params, ctx) {
  return { article: await draftArticleInternal(params, ctx?.progress) };
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

${terminologyGuide(lang)}

Output ONLY the article markdown, no preamble, no JSON, no code fences around
the whole thing.`;
  onProgress?.({ label: "thinking" });
  const article = await runStreamed(prompt, undefined, onProgress);
  if (!article || !article.trim()) {
    throw new Error("Codex returned empty article");
  }
  return article.trim();
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

// OpenAI strict structured output requires every property in `properties`
// to also appear in `required` (no truly-optional fields). All four widget
// fields are therefore listed.
const annotateSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    article: { type: "string" },
    widgets: {
      type: "object",
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        properties: {
          type: { type: "string" },
          placeholder: { type: "boolean" },
          description: { type: "string" },
          alt: { type: "string" },
        },
        required: ["type", "placeholder", "description", "alt"],
      },
    },
  },
  required: ["article", "widgets"],
};

/** Stage 3 — insert image-placeholder widget markers. */
export async function submoduleAnnotate(params, ctx) {
  return await annotateImages(params, ctx?.progress);
}

async function annotateImages({ article, language, topic }, onProgress) {
  const lang = (language || "en").trim();
  const prompt = `You are marking where images should appear in a course
submodule article on "${topic}" (language: ${lang}).

Insert image placeholder widgets at the BEST spots — places where a diagram,
photo, illustration, schema, or chart would meaningfully help comprehension.
Use 1-4 placeholders depending on how visual the topic is (zero is acceptable
for purely abstract topics).

Widget marker syntax — a single line, alone, with blank lines above and below:

::widget{type="image" id="img-1"}

Use ids "img-1", "img-2", ... — small integers.

Each placeholder also gets metadata in the widgets map. "description" must be
a precise instruction for whoever will later source the image — what should be
depicted, the style, what to avoid. "alt" is short alt text. "placeholder" is
true for all of these (we'll later replace with real images).

Article:
<article>
${article}
</article>

${terminologyGuide(lang)}

If no images would help, return article unchanged and widgets as an empty
object {}.`;
  onProgress?.({ label: "marking" });
  const text = await runStreamed(prompt, annotateSchema, onProgress);
  const parsed = JSON.parse(text);
  return {
    article:
      typeof parsed?.article === "string" && parsed.article.trim()
        ? parsed.article.trim()
        : article,
    widgets:
      parsed && typeof parsed.widgets === "object" && parsed.widgets !== null
        ? parsed.widgets
        : {},
  };
}

/**
 * @param {{topic:string, language:string, courseMd:string, structure:object, memoryFiles:{filename:string,content:string}[], modulePath:{title:string,summary:string}, submodulePath:{title:string,summary:string}, previousArticles:{moduleTitle:string,submoduleTitle:string,article:string}[]}} params
 */
export async function generateSubmodule(params) {
  if (!params.modulePath?.title || !params.submodulePath?.title) {
    throw new Error("modulePath and submodulePath must include titles");
  }
  const draft = await draftArticleInternal(params);
  const reviewed = await reviewArticle({ ...params, article: draft });
  const annotated = await annotateImages({ ...params, article: reviewed.article });
  return {
    article: annotated.article,
    widgets: annotated.widgets,
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

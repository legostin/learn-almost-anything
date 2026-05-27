// Claude Agent SDK wrapper.
//
// Subscription auth: when ANTHROPIC_API_KEY is unset, the SDK uses the local
// `claude` CLI auth (Claude Pro/Max subscription). The Rust side strips
// ANTHROPIC_API_KEY from the spawned env to guarantee subscription billing.

import { query } from "@anthropic-ai/claude-agent-sdk";

function terminologyGuide(lang) {
  return `Use the terminology that practitioners in this field actually use in language "${lang}". Prefer established loan words and idiomatic terms over literal translations (e.g. for programming in Russian: "легаси-код", not "наследие-код"; "деплой" / "deploy", not "развёртывание"; "merge request", not "запрос на слияние"). The exact vocabulary depends on the domain — match the register of how professionals in this field actually speak and write.`;
}

async function runOnce(prompt) {
  let text = "";
  for await (const message of query({ prompt, options: { maxTurns: 1 } })) {
    if (message.type === "result" && message.subtype === "success") {
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
 * Stage 1 — draft a fresh article using all available context.
 * @returns {Promise<{ article: string }>}
 */
export async function submoduleDraft({
  topic,
  language,
  courseMd,
  structure,
  memoryFiles,
  modulePath,
  submodulePath,
  previousArticles,
}) {
  return { article: await draftArticleInternal({
    topic, language, courseMd, structure, memoryFiles, modulePath, submodulePath, previousArticles,
  }) };
}

async function draftArticleInternal({
  topic,
  language,
  courseMd,
  structure,
  memoryFiles,
  modulePath,
  submodulePath,
  previousArticles,
}) {
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
  const article = await runOnce(prompt);
  if (!article || !article.trim()) {
    throw new Error("LLM returned empty article");
  }
  return article.trim();
}

/** Stage 2 — editor + fact-check + consistency pass. */
export async function submoduleReview(params) {
  return await reviewArticle(params);
}

async function reviewArticle({ article, language, topic, previousArticles }) {
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
  const text = await runOnce(prompt);
  const parsed = extractJson(text);
  return {
    article:
      typeof parsed?.article === "string" && parsed.article.trim()
        ? parsed.article.trim()
        : article,
    notes: typeof parsed?.notes === "string" ? parsed.notes.trim() : "",
  };
}

/** Stage 3 — insert image-placeholder widget markers. */
export async function submoduleAnnotate(params) {
  return await annotateImages(params);
}

async function annotateImages({ article, language, topic }) {
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
depicted, the style, what to avoid. "alt" is short alt text.

Article:
<article>
${article}
</article>

${terminologyGuide(lang)}

Output ONLY a JSON object on a single line:
{"article":"<article with widget markers inserted, otherwise verbatim>","widgets":{"img-1":{"type":"image","placeholder":true,"description":"<concrete description in ${lang}>","alt":"<short alt in ${lang}>"}}}
If no images would help, return {"article":<unchanged article>,"widgets":{}}.`;
  const text = await runOnce(prompt);
  const parsed = extractJson(text);
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
 * Three-stage submodule pipeline: draft → review → annotate images.
 * Each stage is its own LLM call; the orchestrator returns the final article,
 * the widget map for placeholders, and the editor's notes.
 *
 * @param {{topic:string, language:string, courseMd:string, structure:object, memoryFiles:{filename:string,content:string}[], modulePath:{title:string,summary:string}, submodulePath:{title:string,summary:string}, previousArticles:{moduleTitle:string,submoduleTitle:string,article:string}[]}} params
 * @returns {Promise<{ article: string, widgets: object, review_notes: string }>}
 */
/**
 * Composite — kept for back-compat / smoke tests. Rust now drives the three
 * stages individually so it can emit per-stage progress events.
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

The user will also have a free-text fallback, so do NOT add an "other" option.

Write everything in language "${lang}".

${terminologyGuide(lang)}

Output ONLY a JSON object on a single line, no prose, no markdown fence.
Shape: {"questions":[{"text":"...","options":["...","..."]}]}`;
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
      return { text, options };
    })
    .filter(Boolean);
  if (questions.length === 0) throw new Error("LLM returned zero valid questions");
  return { questions };
}

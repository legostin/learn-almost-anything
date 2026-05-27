// Claude Agent SDK wrapper.
//
// Subscription auth: when ANTHROPIC_API_KEY is unset, the SDK uses the local
// `claude` CLI auth (Claude Pro/Max subscription). The Rust side strips
// ANTHROPIC_API_KEY from the spawned env to guarantee subscription billing.

import { query } from "@anthropic-ai/claude-agent-sdk";

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
FULL tree (4-10 top-level modules × 2-6 submodules), not a diff.`;
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
Constraints:
- Reflect the learner's specific goals, prior knowledge, and constraints from the brief.
- Skip modules irrelevant to those goals; do not produce a generic textbook outline.
- Look up how this subject is typically taught and adapt rather than invent from scratch.
- Use 4-10 top-level modules; each with 2-6 submodules.
- All titles and summaries in language "${lang}".

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

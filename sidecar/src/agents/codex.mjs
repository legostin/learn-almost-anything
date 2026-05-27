// Codex SDK wrapper.
//
// The SDK shells out to the local `codex` CLI binary, which authenticates via
// `codex login` (ChatGPT subscription). When `apiKey` is not provided, the SDK
// uses whatever auth the local CLI has configured — same subscription pattern
// as the Claude side.

import { Codex } from "@openai/codex-sdk";

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

Write everything in language "${lang}".`;

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
Constraints:
- Reflect the learner's specific goals, prior knowledge, and constraints.
- Skip modules irrelevant to those goals; do not produce a generic textbook.
- Look up (web search) how this subject is typically taught and adapt.
- 4-10 top-level modules; each with 2-6 submodules.
- All titles and summaries in language "${lang}".`;

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

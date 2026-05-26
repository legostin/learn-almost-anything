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

/**
 * Generate clarifying questions for a course topic, in the course's language.
 * @param {{ topic: string, language: string }} params
 * @returns {Promise<{ questions: string[] }>}
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
anything topic-specific that matters. Ask only questions that meaningfully
shape the program — skip pleasantries.

Write the questions in language "${lang}".

Output ONLY a JSON object on a single line, with no prose, no markdown fence,
no explanation. Shape: {"questions": ["...", "..."]}`;
  const text = await runOnce(prompt);
  const parsed = extractJson(text);
  if (!Array.isArray(parsed?.questions)) {
    throw new Error("LLM response missing 'questions' array");
  }
  const questions = parsed.questions
    .filter((q) => typeof q === "string" && q.trim().length > 0)
    .map((q) => q.trim());
  if (questions.length === 0) throw new Error("LLM returned zero questions");
  return { questions };
}

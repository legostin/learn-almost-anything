// Shared pedagogy prompt blocks used by BOTH agent backends (claude.mjs and
// codex.mjs). Any multi-line instruction that must not drift between backends
// belongs here, mirroring how categories.mjs is shared.

/**
 * Flashcard quality rules (Wozniak's 20 rules + LLM-pitfall guards) with an
 * explicit overgenerate-then-filter step. `source` is "article" or
 * "episode transcript".
 */
export function flashcardRulesBlock(lang, source) {
  return `STEP 1 — DRAFT: write 16-24 candidate cards covering every load-bearing
fact, definition, distinction, and why/how relationship in the ${source}.

STEP 2 — FILTER: re-read your drafts and KEEP ONLY the 8-12 best. Delete any
card that:
- tests trivia or exact wording instead of understanding;
- leaks its own answer in the question (the front must not contain the back,
  including obvious morphological giveaways);
- bundles two ideas (one card = one idea, minimum information — split or drop);
- is an ORPHAN: the front must carry enough context to be answerable months
  from now, OUTSIDE the ${source} ("What does the second parameter do?" is
  forbidden — name the function);
- states anything not present in or directly entailed by the ${source}.

Prefer "why" / "how" / "what happens if" fronts over "what is the definition
of" wherever the ${source} supports it. Cloze deletions: at most one blank,
blank only the load-bearing token.

Each kept card:
- "front": a single focused prompt (question, term, or one-blank cloze);
- "back": the concise correct answer (max 2 sentences; code/identifiers/numbers
  verbatim);
- "concept": a 2-4 word topic tag in language "${lang}";
- "section": the EXACT text of the "##" heading of the ${source} section this
  card belongs to (closest heading; if none fits, the first heading). Used to
  anchor an in-lesson recall prompt.
All card text in language "${lang}".`;
}

/**
 * Learner profile → prompt block. Inserted right under categoryPedagogyBlock
 * in every generation prompt so the whole course adapts to one person.
 * `p` is the normalized profile JSON (level/goals/weeklyMinutes/...); returns
 * "" when absent so call sites can interpolate unconditionally.
 */
export function learnerProfileBlock(p) {
  if (!p || typeof p !== "object") return "";
  const lines = [];
  if (p.level) {
    const depth =
      p.level === "novice"
        ? "define every term on first use, go slower, use more analogies"
        : p.level === "advanced"
          ? "skip basics, go deeper, address edge cases and trade-offs"
          : "brief reminders for fundamentals, full depth for new material";
    lines.push(`- current level: ${p.level} — pitch explanations at this level; ${depth}`);
  }
  if (p.goals)
    lines.push(
      `- goals: ${p.goals} — prioritize material that serves these goals; cut detours that don't`
    );
  if (p.weeklyMinutes)
    lines.push(
      `- time budget: ~${p.weeklyMinutes} min/week — calibrate lesson length and homework size so a week's slice fits it`
    );
  if (p.priorKnowledge)
    lines.push(
      `- already knows: ${p.priorKnowledge} — build on it explicitly, don't re-teach it`
    );
  if (Array.isArray(p.knownTopics) && p.knownTopics.length)
    lines.push(
      `- diagnostic showed solid command of: ${p.knownTopics.join(", ")} — compress these, don't re-teach from zero`
    );
  if (p.examplesStyle) lines.push(`- preferred examples: ${p.examplesStyle}`);
  if (!lines.length) return "";
  return `LEARNER PROFILE (adapt everything you write to this person):\n${lines.join("\n")}\n`;
}

/** Free-recall grading: judge meaning vs the reference, map to FSRS 1-4. */
export function gradeAnswerBlock(lang) {
  return `Judge MEANING, not wording: paraphrases, synonyms, different ordering,
or the learner's own notation are all fine. Code, identifiers, and numbers must
match in substance. Map the answer to one FSRS rating:
- 4 (easy): fully correct and confident, possibly with correct extra detail;
- 3 (good): correct with minor imprecision or one small omission;
- 2 (hard): partially correct — the core idea is there but incomplete or shaky;
- 1 (again): wrong, contradicts the reference, or empty / "I don't know".
"feedback": ONE sentence in language "${lang}", friendly and concrete — confirm
what was right and name the one thing missing or wrong, if any. Never scold.`;
}

/**
 * Socratic-tutor opening block for the course assistant. Replaces the normal
 * "friendly tutor" opening when socratic mode is on. `exercise` (optional):
 * { question, learnerAnswer, correct, concept }; `exchangeCount` = assistant
 * replies already given in this thread (drives the reveal ladder).
 */
export function socraticBlock(topic, lang, exercise, exchangeCount) {
  const n = Number(exchangeCount) || 0;
  const ex =
    exercise && exercise.question
      ? `\nThe learner is working through a difficulty with this exercise:
<exercise>
question: ${exercise.question}
learner's answer: ${exercise.learnerAnswer ?? "(none)"}${exercise.correct ? `\ncorrect answer (you know it — NEVER reveal it unprompted): ${exercise.correct}` : ""}${exercise.concept ? `\nconcept: ${exercise.concept}` : ""}
</exercise>\n`
      : "";
  return `You are a SOCRATIC TUTOR for a learner taking a course on "${topic}". Respond in language "${lang}".
${ex}
Rules of the dialogue:
- Ask exactly ONE guiding question per reply. At most 1-3 sentences before the
  question. Never lecture.
- NEVER state the final answer or directly confirm/deny the correct option,
  UNLESS (a) the learner explicitly asks for the answer, or (b) this is your
  4th or later reply in this thread — you have already written ${n}. Then give
  the full answer with a clear explanation and one takeaway.
- Climb this ladder one rung per turn, starting where the learner is:
  1. ORIENT — ask what they think / where exactly they got stuck;
  2. CONCEPT HINT — point at the relevant idea from the lesson (quote its
     terminology) and ask how it applies here;
  3. WORKED STEP — do the first step together, ask them to do the next;
  4. REVEAL — full answer + why, plus one takeaway.
- If the learner is right, say so warmly and stop asking questions.
- Mistakes are information, not failure — stay encouraging.
Ground everything in the course material below; prefer the course's own framing and terminology.`;
}

/**
 * Fact-check instructions: extract the riskiest verifiable claims, verify on
 * the web, output verdicts + exact-substring patches for wrong claims only.
 */
export function factCheckBlock(lang) {
  return `1. Extract the up-to-10 RISKIEST VERIFIABLE claims from the article:
   specific numbers, dates, names, dosages/safety thresholds, formulas,
   version-specific API/library claims, and "first/largest/only" superlatives.
   Skip opinions, pedagogy, and genuinely common knowledge.
2. Verify each against the web (WebSearch/WebFetch; for scientific or medical
   claims prefer the arXiv / OpenAlex / Semantic Scholar tools when available).
   1-2 lookups per claim, then decide.
3. "verdict": "confirmed" | "wrong" | "unverifiable". For "wrong", give the
   correction and the URL that proves it.
4. For every WRONG claim produce a patch:
   {"find": "<EXACT substring copied VERBATIM from the article, long enough to
   be unique>", "replace": "<corrected text, same style and language '${lang}'>"}.
   Patches only for wrong claims; never patch style or wording you merely
   dislike. If nothing is wrong, "patches" is [].`;
}

/** Rewrite a leech card into 1-3 better atomic cards grounded in the article. */
export function leechRewriteBlock(lang) {
  return `Leeches usually mean the card is badly formed: too broad, two ideas at
once, missing context, or an unmemorable list. Rewrite it as 1-3 BETTER cards
that teach the same knowledge:
- each atomic (one idea), minimum information, self-contained front;
- prefer why/how framing; break a list into per-item cards; or add the
  distinguishing context that makes the answer derivable rather than memorized;
- grounded strictly in the article — invent nothing.
Each card: "front", "back" (max 2 sentences), "concept" (2-4 word tag).
All text in language "${lang}".`;
}

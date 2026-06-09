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

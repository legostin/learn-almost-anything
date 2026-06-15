# Fact-checking a lesson (load when writing accuracy-sensitive material)

Do this AFTER drafting each lesson, before `lesson_save` — and always for the
"always fact-check" domains (science_math, health, business, data_ai; see
`domains.md`). For other domains, fact-check load-bearing claims at least once.

## Procedure

1. **Extract the ≤10 riskiest verifiable claims** from the article: specific
   numbers, dates, names, dosages / safety thresholds, formulas,
   version-specific API/library claims, and "first/largest/only" superlatives.
   Skip opinions, pedagogy, and genuinely common knowledge.
2. **Verify each against the web** (your WebSearch/WebFetch). For scientific or
   medical claims prefer primary literature (arXiv / OpenAlex / Semantic Scholar,
   PubMed). 1–2 lookups per claim, then decide.
3. **Verdict** per claim: `confirmed` | `wrong` | `unverifiable`.
   - `wrong` → fix it in the article and record the URL that proves the correction.
   - `unverifiable` → soften it (hedge: "often", "in most cases") or drop it.
     **Never** keep an unsourced load-bearing claim in an accuracy-critical domain.
4. **Apply corrections in place** (edit the exact substring; keep the same style
   and language). Add the proving URL to the lesson's `sources`.

## Accuracy-critical domains (science_math, health, business)

- Never invent specifics (numbers, dosages, thresholds, dates, citations).
- Prefer careful/hedged language for anything not well-established.
- For health: never state dosages/thresholds/safety claims you cannot ground in
  an authoritative source.

## What to record

- Keep `sources` honest: list only URLs you actually consulted (see
  `editing-and-sources.md`). The fact-check URLs go there too.

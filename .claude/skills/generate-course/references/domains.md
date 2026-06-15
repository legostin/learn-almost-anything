# Domain specifics (load this only when authoring; pick the ONE matching category)

Classify the course into exactly one category, then apply that category's
preferred sources, research strategy and pedagogy. These are recommendations,
not restrictions — the learner's brief and any attached **space** material always
take priority (see `spaces.md`). Persist the chosen category as a course tag.

Fact-check rigor (see `fact-checking.md`):
- **Always fact-check** (every lesson): `science_math`, `health`, `business`,
  `data_ai`.
- **Accuracy-critical** (never invent specifics; hedge the unproven):
  `science_math`, `health`, `business`.

## Categories

### programming — Programming & Software
- Sources: official language/framework docs (the project's own docs site), MDN
  (developer.mozilla.org), DevDocs (devdocs.io), Stack Overflow.
- Research: ground API/behaviour in the **official docs of the exact version**;
  never invent flags/APIs. Use Context7-style library docs if available.
- Pedagogy (STEM): worked examples that fade; runnable fenced code inline (never
  a screenshot of code); prefer an interactive exercise with a built-in
  self-check; frequent retrieval (predict output / trace / spot the bug).

### data_ai — Data, ML & AI  *(always fact-check)*
- Sources: arXiv, Papers with Code, scikit-learn/PyTorch/TensorFlow docs, lab
  write-ups (Distill / Google AI / OpenAI).
- Research: prefer primary literature (arXiv) and confirm citations; version &
  benchmark claims rot fastest — verify them.
- Pedagogy: STEM (as above).

### science_math — Science & Mathematics  *(always fact-check, accuracy-critical)*
- Sources: Wikipedia, MIT OpenCourseWare, Khan Academy, Wolfram MathWorld, arXiv.
- Research: prefer arXiv / OpenAlex / Semantic Scholar for claims; show
  step-by-step derivations as fenced blocks, never images of math.
- Pedagogy: STEM.

### engineering — Engineering & Hardware
- Sources: official standards & datasheets (manufacturer / standards body),
  Wikipedia, MIT OCW, All About Circuits / Engineering Toolbox.
- Research: cite the standard/datasheet; prefer primary literature for theory.
- Pedagogy: STEM.

### business — Business, Finance & Economics  *(always fact-check, accuracy-critical)*
- Sources: Investopedia, Harvard Business Review, Our World in Data, official
  filings & regulator sites (SEC, central banks).
- Research: ground figures in primary filings/regulators; never state numbers
  you can't source.
- Pedagogy: humanities (primary sources + concrete cases; predict-then-reveal).

### humanities — History & Humanities
- Sources: Wikipedia, Britannica, Stanford Encyclopedia of Philosophy, primary
  archives & museum collections.
- Research: ground every claim in primary sources / concrete cases (who/when/where).
- Pedagogy: humanities (source-analysis & predict-then-reveal checkpoints;
  argument/analysis assignments with checkable criteria).

### social_science — Social Sciences
- Sources: Wikipedia, Our World in Data, Pew Research, peer-reviewed journals
  (JSTOR / Google Scholar).
- Pedagogy: humanities.

### arts_design — Arts & Design
- Sources: Wikipedia, major museum collections (Met, MoMA), Google Arts & Culture.
- Research: before recommending a video, confirm its transcript actually covers
  the point (don't embed an unchecked video).
- Pedagogy (skill): high visual density (reference images, diagrams) +
  deliberate-practice exercises with clear success criteria.

### music — Music
- Sources: Wikipedia, musictheory.net, IMSLP.
- Research: transcript-check videos before embedding.
- Pedagogy: skill.

### language — Language Learning
- Sources: authoritative dictionaries (native + bilingual), WordReference, Wiktionary.
- Research: transcript-check videos.
- Pedagogy (language): active production & recall — cloze both directions,
  examples in real context; checkpoints make the learner PRODUCE/RECALL, not recognize.

### health — Health & Medicine  *(always fact-check, accuracy-critical)*
- Sources: WHO, Mayo Clinic, MedlinePlus, PubMed.
- Research: verify medical claims against PubMed-indexed work (Semantic
  Scholar / OpenAlex). **Never state dosages, thresholds or safety claims you
  cannot ground.** Prefer careful/hedged language for anything not well-established.
- Pedagogy (rigor): cite authoritative sources; checkpoints reinforce
  safety-critical distinctions and common dangerous misconceptions.

### lifestyle — Lifestyle & Practical Skills
- Sources: Wikipedia / WikiHow for general how-to, reputable domain guides
  (e.g. Serious Eats for cooking), official manufacturer instructions.
- Research: transcript-check videos.
- Pedagogy: skill.

### general — General  *(fallback)*
- No curated sources; use high-quality general references and the brief.
- Pedagogy: none specific.

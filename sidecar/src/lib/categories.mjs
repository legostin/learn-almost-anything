// Course categorizer taxonomy.
//
// One fixed set of category ids shared across the stack: the agent classifies a
// course into exactly one of these during structure generation, the id is
// persisted on the course (Rust: normalize_category), shown in the UI
// (App.tsx CATEGORY_LABELS), and used here to inject a handful of reputable
// "preferred sources" for that kind of subject into the writing prompt.
//
// Keep the id list in sync with normalize_category (src-tauri/src/db.rs) and
// CATEGORY_LABELS (src/App.tsx).

/** @typedef {{ title: string, url: string }} Source */

// Short per-category research-tool hints, appended to the preferred-sources
// block when the category has dedicated MCP tools granted (reference-mcp.mjs
// researchMcpServersForCategory). Keep these to 1-2 sentences — they run on
// every draft.
const SCIENCE_TOOL_HINT =
  "For scientific claims, prefer the dedicated research tools over open-web search: arXiv tools (arxiv_search / arxiv_read_paper) for primary literature, OpenAlex (search_works / search_by_topic) and Semantic Scholar (search_papers — it is slow, 1-2 lookups max) to confirm citations and find canonical papers.";
const HEALTH_TOOL_HINT =
  "Verify medical claims against PubMed-indexed work via the Semantic Scholar / OpenAlex tools (1-2 lookups max — Semantic Scholar is slow); never state dosages, thresholds, or safety claims you could not ground.";
const VIDEO_TOOL_HINT =
  "Before recommending a video, pull its transcript with the youtube-transcript tool (get-transcript) and confirm it actually covers the lesson's points — never embed a video you have not transcript-checked.";

/** Ordered taxonomy. `general` is the fallback and intentionally has no sources. */
export const CATEGORIES = [
  {
    id: "programming",
    label: "Programming & Software",
    sources: [
      { title: "Official language/framework documentation", url: "the project's own docs site" },
      { title: "MDN Web Docs", url: "https://developer.mozilla.org" },
      { title: "DevDocs", url: "https://devdocs.io" },
      { title: "Stack Overflow", url: "https://stackoverflow.com" },
    ],
  },
  {
    id: "data_ai",
    toolHint: SCIENCE_TOOL_HINT,
    label: "Data, ML & AI",
    sources: [
      { title: "arXiv", url: "https://arxiv.org" },
      { title: "Papers with Code", url: "https://paperswithcode.com" },
      { title: "scikit-learn / PyTorch / TensorFlow docs", url: "the library's official docs" },
      { title: "Distill / Google AI / OpenAI research write-ups", url: "the lab's official site" },
    ],
  },
  {
    id: "science_math",
    toolHint: SCIENCE_TOOL_HINT,
    label: "Science & Mathematics",
    sources: [
      { title: "Wikipedia", url: "https://en.wikipedia.org" },
      { title: "MIT OpenCourseWare", url: "https://ocw.mit.edu" },
      { title: "Khan Academy", url: "https://www.khanacademy.org" },
      { title: "Wolfram MathWorld", url: "https://mathworld.wolfram.com" },
      { title: "arXiv", url: "https://arxiv.org" },
    ],
  },
  {
    id: "engineering",
    toolHint: SCIENCE_TOOL_HINT,
    label: "Engineering & Hardware",
    sources: [
      { title: "Official standards & datasheets", url: "the manufacturer / standards body site" },
      { title: "Wikipedia", url: "https://en.wikipedia.org" },
      { title: "MIT OpenCourseWare", url: "https://ocw.mit.edu" },
      { title: "All About Circuits / Engineering Toolbox", url: "the reference site" },
    ],
  },
  {
    id: "business",
    label: "Business, Finance & Economics",
    sources: [
      { title: "Investopedia", url: "https://www.investopedia.com" },
      { title: "Harvard Business Review", url: "https://hbr.org" },
      { title: "Our World in Data", url: "https://ourworldindata.org" },
      { title: "Official filings & regulator sites (SEC, central banks)", url: "the primary source" },
    ],
  },
  {
    id: "humanities",
    label: "History & Humanities",
    sources: [
      { title: "Wikipedia", url: "https://en.wikipedia.org" },
      { title: "Encyclopaedia Britannica", url: "https://www.britannica.com" },
      { title: "Stanford Encyclopedia of Philosophy", url: "https://plato.stanford.edu" },
      { title: "Primary-source archives & museum collections", url: "the archive's official site" },
    ],
  },
  {
    id: "social_science",
    label: "Social Sciences",
    sources: [
      { title: "Wikipedia", url: "https://en.wikipedia.org" },
      { title: "Our World in Data", url: "https://ourworldindata.org" },
      { title: "Pew Research Center", url: "https://www.pewresearch.org" },
      { title: "Peer-reviewed journals (via JSTOR / Google Scholar)", url: "https://scholar.google.com" },
    ],
  },
  {
    id: "arts_design",
    toolHint: VIDEO_TOOL_HINT,
    label: "Arts & Design",
    sources: [
      { title: "Wikipedia", url: "https://en.wikipedia.org" },
      { title: "Major museum collections (The Met, MoMA, etc.)", url: "the museum's official site" },
      { title: "Google Arts & Culture", url: "https://artsandculture.google.com" },
    ],
  },
  {
    id: "music",
    toolHint: VIDEO_TOOL_HINT,
    label: "Music",
    sources: [
      { title: "Wikipedia", url: "https://en.wikipedia.org" },
      { title: "musictheory.net", url: "https://www.musictheory.net" },
      { title: "IMSLP (Petrucci Music Library)", url: "https://imslp.org" },
    ],
  },
  {
    id: "language",
    toolHint: VIDEO_TOOL_HINT,
    label: "Language Learning",
    sources: [
      { title: "Authoritative dictionaries (native + bilingual)", url: "the dictionary's official site" },
      { title: "WordReference", url: "https://www.wordreference.com" },
      { title: "Wiktionary", url: "https://en.wiktionary.org" },
    ],
  },
  {
    id: "health",
    toolHint: HEALTH_TOOL_HINT,
    label: "Health & Medicine",
    sources: [
      { title: "World Health Organization", url: "https://www.who.int" },
      { title: "Mayo Clinic", url: "https://www.mayoclinic.org" },
      { title: "MedlinePlus", url: "https://medlineplus.gov" },
      { title: "PubMed", url: "https://pubmed.ncbi.nlm.nih.gov" },
    ],
  },
  {
    id: "lifestyle",
    toolHint: VIDEO_TOOL_HINT,
    label: "Lifestyle & Practical Skills",
    sources: [
      { title: "Wikipedia / WikiHow for general how-to", url: "https://en.wikipedia.org" },
      { title: "Reputable domain guides (e.g. Serious Eats for cooking)", url: "the established guide site" },
      { title: "Official manufacturer instructions", url: "the product's own docs" },
    ],
  },
  { id: "general", label: "General", sources: [] },
];

const BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));

/** All valid category ids, in display order. */
export const CATEGORY_IDS = CATEGORIES.map((c) => c.id);

/** Lowercase/trim a model-provided value to a valid id, or null. */
export function normalizeCategory(value) {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return BY_ID.has(v) ? v : null;
}

/** Bullet list of ids + labels for the classification instruction. */
export function categoryClassifyGuide() {
  return CATEGORIES.map((c) => `  - ${c.id} — ${c.label}`).join("\n");
}

/**
 * Reputable preferred-sources block for one category. Empty string when the
 * category is unknown, "general", or has no curated sources. These are
 * recommendations the agent should favor, NOT restrictions.
 */
export function categoryPreferredSourcesBlock(category, lang) {
  const cat = BY_ID.get(normalizeCategory(category) || "");
  if (!cat || !cat.sources.length) return "";
  const list = cat.sources.map((s) => `- ${s.title}: ${s.url}`).join("\n");
  const toolHint = cat.toolHint ? `${cat.toolHint}\n` : "";
  return `\n=== RECOMMENDED SOURCES FOR THIS CATEGORY (${cat.label}) ===
For grounding facts and examples, start from these reputable sources for this kind of subject and favor them over random open-web pages. They are recommendations, not restrictions — you may still use other high-quality sources, and the learner's brief (and any attached space material) always takes priority. Write in language "${(lang || "en").trim()}".
${list}
${toolHint}`;
}

// Each category maps to one of a few teaching ARCHETYPES (kept small on purpose —
// per-domain recipes that scale, not 13 bespoke prompts).
const ARCHETYPE_BY_CATEGORY = {
  programming: "stem",
  data_ai: "stem",
  science_math: "stem",
  engineering: "stem",
  language: "language",
  humanities: "humanities",
  social_science: "humanities",
  business: "humanities",
  arts_design: "skill",
  music: "skill",
  lifestyle: "skill",
  health: "rigor",
  general: "",
};

const ARCHETYPE_RECIPES = {
  stem: `Teach by WORKED EXAMPLES that FADE: a fully worked example first, then a guided one with a step left for the learner, then an independent problem.
- Put real, runnable CODE or step-by-step DERIVATIONS inline as fenced blocks (never a screenshot of code or math).
- Strongly prefer a runnable interactive exercise widget with a BUILT-IN self-check — the learner DOES something (writes/runs code, computes a value) and the widget tells them right or wrong. Doing beats reading here.
- Use frequent retrieval: ask the learner to predict an output, trace a value, or spot the bug BEFORE revealing the answer.`,
  language: `Emphasize active PRODUCTION and RECALL over explanation:
- cloze (fill-in-the-blank) prompts, both L2->native and native->L2 directions, and short examples in real context.
- Checkpoints must make the learner PRODUCE or RECALL a word/phrase, not merely recognize it.`,
  humanities: `Ground every claim in primary sources and concrete cases (who / when / where).
- Use source-analysis and predict-then-reveal checkpoints (interpret a passage, predict an outcome, then compare).
- Assignments lean toward short argument/analysis with explicit, checkable criteria.`,
  skill: `Lead with HIGH VISUAL DENSITY (reference images, diagrams) and DELIBERATE-PRACTICE exercises with clear success criteria.
- Checkpoints ask the learner to critique an example or plan a concrete practice rep.`,
  rigor: `Accuracy-critical domain: cite authoritative sources, never invent specifics, and prefer careful/hedged language for anything not well-established.
- Checkpoints reinforce safety-critical distinctions and common dangerous misconceptions.`,
};

/**
 * Per-category teaching recipe injected next to the preferred-sources block at
 * the draft/test/assignment prompt sites. Empty for lean intensity, unknown
 * category, or the general archetype.
 */
export function categoryPedagogyBlock(category, lang, intensity) {
  if (intensity === "lean") return "";
  const id = normalizeCategory(category);
  const recipe = id ? ARCHETYPE_RECIPES[ARCHETYPE_BY_CATEGORY[id]] : null;
  if (!recipe) return "";
  const label = BY_ID.get(id)?.label || id;
  const depth =
    intensity === "max" ? "Apply it thoroughly." : "Apply it where it naturally fits.";
  return `\n=== PEDAGOGY RECIPE FOR THIS CATEGORY (${label}) ===
${recipe}
Apply this in language "${(lang || "en").trim()}". ${depth}\n`;
}

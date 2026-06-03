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
    label: "Arts & Design",
    sources: [
      { title: "Wikipedia", url: "https://en.wikipedia.org" },
      { title: "Major museum collections (The Met, MoMA, etc.)", url: "the museum's official site" },
      { title: "Google Arts & Culture", url: "https://artsandculture.google.com" },
    ],
  },
  {
    id: "music",
    label: "Music",
    sources: [
      { title: "Wikipedia", url: "https://en.wikipedia.org" },
      { title: "musictheory.net", url: "https://www.musictheory.net" },
      { title: "IMSLP (Petrucci Music Library)", url: "https://imslp.org" },
    ],
  },
  {
    id: "language",
    label: "Language Learning",
    sources: [
      { title: "Authoritative dictionaries (native + bilingual)", url: "the dictionary's official site" },
      { title: "WordReference", url: "https://www.wordreference.com" },
      { title: "Wiktionary", url: "https://en.wiktionary.org" },
    ],
  },
  {
    id: "health",
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
  return `\n=== RECOMMENDED SOURCES FOR THIS CATEGORY (${cat.label}) ===
For grounding facts and examples, start from these reputable sources for this kind of subject and favor them over random open-web pages. They are recommendations, not restrictions — you may still use other high-quality sources, and the learner's brief (and any attached space material) always takes priority. Write in language "${(lang || "en").trim()}".
${list}\n`;
}

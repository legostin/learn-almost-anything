// Parameterized interactive-widget templates. The LLM fills ONLY params; the
// app renders each template natively (React components in src/App.tsx — the
// expression grammar below is a shared contract with the frontend evaluator).
// normalizeTemplateWidget is the single source of truth for validation in both
// agent backends: it clamps counts, drops invalid entries, and returns null
// when a widget is unusable (the caller then drops it; its article marker is
// cleaned up by the existing stripUnknownWidgetMarkers pass).

export const TEMPLATE_NAMES = [
  "quiz",
  "steps",
  "match",
  "fillblank",
  "order",
  "slider",
  "categorize",
  "flipcards",
  "code",
];

// Languages the desktop app can execute locally (see src-tauri/src/coderun.rs).
export const CODE_LANGS = ["python", "javascript", "go", "c", "cpp", "rust", "java"];
const CODE_LANG_ALIASES = {
  py: "python",
  python3: "python",
  js: "javascript",
  node: "javascript",
  nodejs: "javascript",
  golang: "go",
  "c++": "cpp",
  rs: "rust",
};

/** Resolve a model-supplied language to a runnable id, or null. */
export function normalizeCodeLang(value) {
  const v = String(value ?? "")
    .trim()
    .toLowerCase();
  return CODE_LANGS.includes(v) ? v : CODE_LANG_ALIASES[v] || null;
}

// ── Safe expression evaluator (slider template) ─────────────────────────────
// Grammar: numbers, declared variable names, + - * / ^ (right-assoc pow),
// unary minus (binds looser than ^: -x^2 == -(x^2)), parentheses, constants
// pi/e, functions sin cos tan sqrt abs log exp round floor ceil (1 arg) and
// min max pow (2 args). NO eval / new Function — recursive descent only.

const FN1 = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  sqrt: Math.sqrt,
  abs: Math.abs,
  log: Math.log,
  exp: Math.exp,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
};
const FN2 = { min: Math.min, max: Math.max, pow: Math.pow };
const CONSTS = { pi: Math.PI, e: Math.E };

function tokenizeExpr(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
    } else if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      const num = Number(src.slice(i, j));
      if (!Number.isFinite(num)) return null;
      tokens.push({ t: "num", v: num });
      i = j;
    } else if (/[a-zA-Z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[a-zA-Z0-9_]/.test(src[j])) j++;
      tokens.push({ t: "ident", v: src.slice(i, j) });
      i = j;
    } else if ("+-*/^(),".includes(c)) {
      tokens.push({ t: c });
      i++;
    } else {
      return null; // unknown character — reject the whole expression
    }
  }
  return tokens;
}

/**
 * Evaluate `expr` with the given variable scope. Returns a finite-or-Infinity
 * number, or null when the expression is invalid (unknown token/ident, bad
 * syntax). Never throws, never eval()s.
 */
export function evalExpr(expr, scope) {
  const tokens = typeof expr === "string" ? tokenizeExpr(expr) : null;
  if (!tokens || !tokens.length) return null;
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = (t) => (tokens[pos]?.t === t ? tokens[pos++] : null);
  let failed = false;
  const fail = () => {
    failed = true;
    return 0;
  };

  function parseExprLevel() {
    // additive
    let v = parseTerm();
    for (;;) {
      if (eat("+")) v += parseTerm();
      else if (eat("-")) v -= parseTerm();
      else return v;
    }
  }
  function parseTerm() {
    let v = parseUnary();
    for (;;) {
      if (eat("*")) v *= parseUnary();
      else if (eat("/")) v /= parseUnary();
      else return v;
    }
  }
  function parseUnary() {
    if (eat("-")) return -parseUnary();
    return parsePower();
  }
  function parsePower() {
    const base = parseAtom();
    if (eat("^")) return Math.pow(base, parseUnary()); // right-assoc
    return base;
  }
  function parseAtom() {
    const tok = peek();
    if (!tok) return fail();
    if (tok.t === "num") {
      pos++;
      return tok.v;
    }
    if (tok.t === "(") {
      pos++;
      const v = parseExprLevel();
      if (!eat(")")) return fail();
      return v;
    }
    if (tok.t === "ident") {
      pos++;
      const name = tok.v;
      if (eat("(")) {
        const args = [parseExprLevel()];
        while (eat(",")) args.push(parseExprLevel());
        if (!eat(")")) return fail();
        if (FN1[name] && args.length === 1) return FN1[name](args[0]);
        if (FN2[name] && args.length === 2) return FN2[name](args[0], args[1]);
        return fail();
      }
      if (Object.prototype.hasOwnProperty.call(scope ?? {}, name)) return scope[name];
      if (name in CONSTS) return CONSTS[name];
      return fail();
    }
    return fail();
  }

  const result = parseExprLevel();
  if (failed || pos !== tokens.length) return null;
  return typeof result === "number" && !Number.isNaN(result) ? result : null;
}

// ── Normalization helpers ───────────────────────────────────────────────────

function str(v) {
  return typeof v === "string" ? v.trim() : "";
}
function strArr(v, min, max) {
  if (!Array.isArray(v)) return null;
  const out = v.map(str).filter(Boolean).slice(0, max);
  return out.length >= min ? out : null;
}
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeQuiz(p) {
  const items = (Array.isArray(p?.items) ? p.items : [])
    .map((it) => {
      const question = str(it?.question);
      const options = strArr(it?.options, 2, 5);
      if (!question || !options) return null;
      const correct =
        Number.isInteger(it?.correct) && it.correct >= 0 && it.correct < options.length
          ? it.correct
          : null;
      if (correct === null) return null;
      const explanation = str(it?.explanation);
      return { question, options, correct, ...(explanation ? { explanation } : {}) };
    })
    .filter(Boolean)
    .slice(0, 6);
  return items.length >= 2 ? { items } : null;
}

function normalizeSteps(p) {
  const steps = (Array.isArray(p?.steps) ? p.steps : [])
    .map((s) => {
      const text = str(s?.text);
      if (!text) return null;
      const title = str(s?.title);
      const code = typeof s?.code === "string" ? s.code : "";
      const codeLang = str(s?.codeLang);
      return {
        ...(title ? { title } : {}),
        text,
        ...(code.trim() ? { code, ...(codeLang ? { codeLang } : {}) } : {}),
      };
    })
    .filter(Boolean)
    .slice(0, 8);
  return steps.length >= 2 ? { steps } : null;
}

function normalizeMatch(p) {
  const pairs = (Array.isArray(p?.pairs) ? p.pairs : [])
    .map((pr) => {
      const left = str(pr?.left);
      const right = str(pr?.right);
      return left && right ? { left, right } : null;
    })
    .filter(Boolean)
    .slice(0, 8);
  if (pairs.length < 3) return null;
  const prompt = str(p?.prompt);
  return { ...(prompt ? { prompt } : {}), pairs };
}

function normalizeFillblank(p) {
  const items = (Array.isArray(p?.items) ? p.items : [])
    .map((it) => {
      // Normalize runs of 3+ underscores to the canonical ___ gap token.
      let text = str(it?.text).replace(/_{3,}/g, "___");
      if (!text) return null;
      // Exactly one gap per item.
      if ((text.match(/___/g) || []).length !== 1) return null;
      const answers = strArr(it?.answers, 1, 5);
      if (!answers) return null;
      const hint = str(it?.hint);
      return { text, answers, ...(hint ? { hint } : {}) };
    })
    .filter(Boolean)
    .slice(0, 5);
  return items.length >= 1 ? { items } : null;
}

function normalizeOrder(p) {
  const items = strArr(p?.items, 3, 7);
  if (!items) return null;
  const prompt = str(p?.prompt);
  return { ...(prompt ? { prompt } : {}), items };
}

function normalizeSlider(p) {
  const vars = (Array.isArray(p?.vars) ? p.vars : [])
    .map((v) => {
      const name = str(v?.name);
      const label = str(v?.label) || name;
      const min = num(v?.min);
      const max = num(v?.max);
      const step = num(v?.step);
      let init = num(v?.init);
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) return null;
      if (name in CONSTS || FN1[name] || FN2[name]) return null;
      if (min === null || max === null || !(min < max)) return null;
      if (step === null || !(step > 0)) return null;
      if (init === null) init = min;
      init = Math.min(max, Math.max(min, init));
      return { name, label, min, max, step, init };
    })
    .filter(Boolean)
    .slice(0, 3);
  if (vars.length < 1) return null;
  // Reject duplicate variable names — the scope would be ambiguous.
  if (new Set(vars.map((v) => v.name)).size !== vars.length) return null;
  const scope = Object.fromEntries(vars.map((v) => [v.name, v.init]));
  const outputs = (Array.isArray(p?.outputs) ? p.outputs : [])
    .map((o) => {
      const label = str(o?.label);
      const expr = str(o?.expr);
      if (!label || !expr) return null;
      // Validate the formula by test-evaluating at the initial values.
      const probe = evalExpr(expr, scope);
      if (probe === null) return null;
      const format = ["int", "fixed1", "fixed2"].includes(o?.format) ? o.format : "auto";
      const suffix = str(o?.suffix);
      const barMin = num(o?.bar?.min);
      const barMax = num(o?.bar?.max);
      const bar =
        barMin !== null && barMax !== null && barMin < barMax
          ? { min: barMin, max: barMax }
          : null;
      return {
        label,
        expr,
        format,
        ...(suffix ? { suffix } : {}),
        ...(bar ? { bar } : {}),
      };
    })
    .filter(Boolean)
    .slice(0, 3);
  if (outputs.length < 1) return null;
  const note = str(p?.note);
  return { ...(note ? { note } : {}), vars, outputs };
}

function normalizeCategorize(p) {
  const buckets = strArr(p?.buckets, 2, 4);
  if (!buckets) return null;
  const items = (Array.isArray(p?.items) ? p.items : [])
    .map((it) => {
      const text = str(it?.text);
      const bucket =
        Number.isInteger(it?.bucket) && it.bucket >= 0 && it.bucket < buckets.length
          ? it.bucket
          : null;
      return text && bucket !== null ? { text, bucket } : null;
    })
    .filter(Boolean)
    .slice(0, 10);
  if (items.length < 4) return null;
  const prompt = str(p?.prompt);
  return { ...(prompt ? { prompt } : {}), buckets, items };
}

function normalizeFlipcards(p) {
  const cards = (Array.isArray(p?.cards) ? p.cards : [])
    .map((c) => {
      const front = str(c?.front);
      const back = str(c?.back);
      return front && back ? { front, back } : null;
    })
    .filter(Boolean)
    .slice(0, 8);
  return cards.length >= 3 ? { cards } : null;
}

// Code blocks keep raw (untrimmed) strings: indentation and trailing newlines
// matter for source code and expected output.
function rawStr(v, max) {
  if (typeof v !== "string" || !v.trim()) return "";
  return v.length <= max ? v : "";
}

function normalizeCode(p) {
  const requested = str(p?.language).toLowerCase();
  const language = CODE_LANGS.includes(requested)
    ? requested
    : CODE_LANG_ALIASES[requested] || null;
  if (!language) return null;
  const code = rawStr(p?.code, 8000);
  if (!code) return null;
  const task = str(p?.task).slice(0, 1000);
  const solution = rawStr(p?.solution, 8000);
  const expected = rawStr(p?.expected_output, 4000);
  const hint = str(p?.hint).slice(0, 300);
  const stdin = rawStr(p?.stdin, 2000);
  // Exercise only when fully specified; otherwise downgrade to a runnable
  // example instead of dropping the widget.
  const exercise = p?.mode === "exercise" && task && solution && expected;
  return {
    language,
    mode: exercise ? "exercise" : "example",
    code,
    ...(exercise ? { task, solution, expected_output: expected } : {}),
    ...(hint ? { hint } : {}),
    ...(stdin ? { stdin } : {}),
  };
}

const NORMALIZERS = {
  quiz: normalizeQuiz,
  steps: normalizeSteps,
  match: normalizeMatch,
  fillblank: normalizeFillblank,
  order: normalizeOrder,
  slider: normalizeSlider,
  categorize: normalizeCategorize,
  flipcards: normalizeFlipcards,
  code: normalizeCode,
};

/**
 * Validate + normalize one template widget. Accepts `params` as an object or
 * a JSON string (the codex structured-output path sends paramsJson). Returns
 * the normalized widget or null when unusable. Idempotent.
 */
export function normalizeTemplateWidget(raw) {
  if (!raw || typeof raw !== "object") return null;
  const template = str(raw.template);
  const normalize = NORMALIZERS[template];
  if (!normalize) return null;
  let params = raw.params;
  if (typeof params === "string") {
    try {
      params = JSON.parse(params);
    } catch {
      return null;
    }
  }
  const normalized = normalize(params);
  if (!normalized) return null;
  return {
    type: "interactive",
    template,
    title: str(raw.title),
    description: str(raw.description),
    params: normalized,
  };
}

/**
 * Compact prompt catalog: replaces the free-form interactive-widget
 * instructions in both agents' draft prompts.
 */
export function templateCatalogBlock(lang, category) {
  // The runnable-code template only makes sense for programming-adjacent
  // courses. An undefined category (e.g. the fix-widget path) keeps it
  // included so widget repair still knows the schema.
  const codeEntry =
    category === undefined || ["programming", "data_ai"].includes(category)
      ? `
- code — runnable code block (the desktop app executes it locally). Two modes.
  params: {"language":"python|javascript|go|c|cpp|rust|java","mode":"example|exercise",
           "code":"<full runnable source>","task"?,"solution"?,"expected_output"?,"hint"?,"stdin"?}
  example: complete, ready-to-run code the learner tweaks and runs.
  exercise: "code" is starter code with a clearly marked gap (a TODO comment),
  "task" tells the learner what to implement (in language "${lang}"), "solution" is
  the complete working version, "expected_output" is the EXACT stdout of the solution.
  HARD RULES for code: self-contained single file; standard library only — no
  third-party packages, no file or network access, no input()/readline prompts
  (provide stdin via the "stdin" param instead); must finish in under 5 seconds;
  exercises must print DETERMINISTIC output (no randomness, time, or hash-order
  dependence). Java: any class name works (single-file launcher). Prefer "code"
  over "steps" whenever the learner should RUN the code, not just read it.`
      : "";
  return `TEMPLATE WIDGETS (type "interactive"): pick from this FIXED catalog — you supply
ONLY parameters; the app renders the UI natively. Use 0-2 per submodule, only where
interaction genuinely aids learning. All learner-visible strings in language "${lang}".
Widget shape: {"id":"int-1","type":"interactive","template":"<name>","title":"<short label>","description":"<1-2 sentences>","params":{...}}
- quiz — multiple-choice check with explanations and a score.
  params: {"items":[{"question","options":[2-5 strings],"correct":<0-based index>,"explanation"?}]} (2-6 items)
- steps — Prev/Next walkthrough of a process or algorithm.
  params: {"steps":[{"title"?,"text":"<markdown>","code"?,"codeLang"?}]} (2-8 steps)
- match — match pairs by tapping one item from each column.
  params: {"prompt"?,"pairs":[{"left","right"}]} (3-8 pairs)
- fillblank — sentences with a typed-in gap; "___" marks the single gap.
  params: {"items":[{"text":"... ___ ...","answers":[1-5 accepted strings],"hint"?}]} (1-5 items)
- order — arrange shuffled items into the correct order.
  params: {"prompt"?,"items":["first","second",...]} (3-7 strings, given in CORRECT order)
- slider — 1-3 sliders driving live computed outputs (quantitative intuition).
  params: {"note"?,"vars":[{"name","label","min","max","step","init"}] (1-3),
           "outputs":[{"label","expr","format"? "auto|int|fixed1|fixed2","suffix"?,"bar":{"min","max"}?}] (1-3)}
  expr may use ONLY: numbers, var names, + - * / ^ ( ), pi, e, and
  sin cos tan sqrt abs log exp round floor ceil (1 arg), min max pow (2 args).
- categorize — sort items into 2-4 buckets, then check.
  params: {"prompt"?,"buckets":[2-4 strings],"items":[{"text","bucket":<index>}]} (4-10 items)
- flipcards — a small flip-through card deck (vocabulary, term/definition).
  params: {"cards":[{"front","back"}]} (3-8 cards)${codeEntry}
Pick by pedagogy: quiz/fillblank for recall, steps for procedures, match/categorize
for relationships, order for sequences, slider for quantitative intuition, flipcards
for vocabulary. Do NOT invent other templates or extra param fields. Do NOT write
HTML/CSS/JS.`;
}

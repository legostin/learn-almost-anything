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

// ===== Chart widgets (type "chart") =====
// A data/function chart rendered natively (Chart.js) in the app and on the web.
// normalizeChartWidget clamps/validates and returns null when unrenderable, so
// both agent backends drop a bad chart and its article marker is cleaned up.

const CHART_KINDS = [
  "line", "bar", "area", "pie", "doughnut", "radar",
  "polarArea", "scatter", "bubble", "function", "mixed",
];
const CHART_RESERVED = ["__proto__", "constructor", "prototype"];

function chartColorOk(v) {
  if (typeof v !== "string") return false;
  const s = v.trim();
  return /^#([0-9a-f]{3,8})$/i.test(s) || /^(rgb|rgba|hsl|hsla)\(/i.test(s) || /^[a-z]{3,20}$/i.test(s);
}

export function normalizeChartWidget(raw) {
  if (!raw || typeof raw !== "object") return null;
  let kind = String(raw.chartType ?? raw.chart ?? raw.kind ?? "").toLowerCase().trim();
  if (!kind || ["chart", "graph", "plot", "widget"].includes(kind)) {
    kind = String(raw.chart ?? raw.kind ?? raw.chartType ?? "line").toLowerCase().trim();
  }
  const alias = { donut: "doughnut", polar: "polarArea", polararea: "polarArea", col: "bar", column: "bar", columns: "bar", fn: "function" };
  kind = alias[kind] ?? kind;
  if (!CHART_KINDS.includes(kind)) kind = "line";

  let rawDs = Array.isArray(raw.datasets) ? raw.datasets : null;
  if (!rawDs && Array.isArray(raw.data)) rawDs = [{ data: raw.data, label: raw.label }];
  if (!rawDs && typeof raw.expr === "string") rawDs = [{ expr: raw.expr, label: raw.label }];

  const pointLike = kind === "scatter" || kind === "bubble";
  const datasets = [];
  for (const ds of (Array.isArray(rawDs) ? rawDs : []).slice(0, 16)) {
    if (!ds || typeof ds !== "object") continue;
    const expr = typeof ds.expr === "string" && ds.expr.trim() ? ds.expr.trim().slice(0, 240) : null;
    const data = [];
    if (Array.isArray(ds.data)) {
      for (const p of ds.data.slice(0, 2000)) {
        if (p && typeof p === "object" && ("x" in p || "y" in p)) {
          const e = { x: num(p.x), y: num(p.y) };
          if (num(p.r) !== null) e.r = Math.max(0, Math.min(60, num(p.r)));
          data.push(e);
        } else if (pointLike && Array.isArray(p) && p.length >= 2) {
          data.push({ x: num(p[0]), y: num(p[1]) });
        } else {
          data.push(num(p));
        }
      }
    }
    if (data.length === 0 && !expr) continue;
    let dsType = typeof ds.type === "string" ? ds.type.toLowerCase() : null;
    if (dsType && !["line", "bar", "area", "scatter", "bubble"].includes(dsType)) dsType = null;
    const out = {};
    if (str(ds.label)) out.label = str(ds.label).slice(0, 80);
    if (expr) out.expr = expr;
    else out.data = data;
    if (chartColorOk(ds.color)) out.color = ds.color.trim();
    if (typeof ds.fill === "boolean") out.fill = ds.fill;
    if (typeof ds.dashed === "boolean") out.dashed = ds.dashed;
    if (dsType) out.type = dsType;
    if (str(ds.stack)) out.stack = str(ds.stack).slice(0, 40);
    if (num(ds.pointRadius) !== null) out.pointRadius = Math.max(0, Math.min(20, num(ds.pointRadius)));
    datasets.push(out);
  }
  const hasExpr = datasets.some((d) => d.expr);
  if (datasets.length === 0 && !hasExpr) return null;

  let controls = null;
  if (Array.isArray(raw.controls)) {
    const seen = new Set();
    const out = [];
    for (const c of raw.controls.slice(0, 10)) {
      if (!c || typeof c.name !== "string") continue;
      const name = c.name.replace(/[^a-zA-Z0-9_]/g, "");
      if (!name || !/^[a-zA-Z_]/.test(name) || CHART_RESERVED.includes(name) || seen.has(name)) continue;
      seen.add(name);
      let min = num(c.min) ?? 0;
      let max = num(c.max) ?? 10;
      if (!(max > min)) max = min + 1;
      let value = num(c.value ?? c.init ?? c.default);
      if (value === null) value = min;
      value = Math.max(min, Math.min(max, value));
      let step = num(c.step);
      if (!(step > 0)) step = Math.round(((max - min) / 100) * 1e6) / 1e6;
      const ctl = { name, label: (str(c.label) || name).slice(0, 60), min, max, step, value };
      if (str(c.unit)) ctl.unit = str(c.unit).slice(0, 12);
      out.push(ctl);
    }
    controls = out.length ? out : null;
  }

  let domain = null;
  if (raw.domain && typeof raw.domain === "object") {
    const dmin = num(raw.domain.min);
    const dmax = num(raw.domain.max);
    if (dmin !== null && dmax !== null && dmax > dmin) {
      const samples = Math.max(2, Math.min(600, Math.round(num(raw.domain.samples) ?? 100)));
      let v = String(raw.domain.var ?? "x").replace(/[^a-zA-Z_]/g, "") || "x";
      if (CHART_RESERVED.includes(v)) v = "x";
      domain = { min: dmin, max: dmax, samples, var: v };
    }
  }
  if (hasExpr && !domain) domain = { min: -10, max: 10, samples: 100, var: "x" };
  // Every expression must evaluate (against control initials + the domain var),
  // otherwise the chart would draw nothing.
  if (hasExpr) {
    const scope = {};
    (controls || []).forEach((c) => (scope[c.name] = c.value));
    scope[domain.var] = (domain.min + domain.max) / 2;
    for (const d of datasets) {
      if (d.expr && evalExpr(d.expr, scope) === null) return null;
    }
  }

  let labels = null;
  if (Array.isArray(raw.labels)) {
    labels = raw.labels
      .slice(0, 2000)
      .filter((l) => l !== null && typeof l !== "object")
      .map((l) => String(l).slice(0, 120));
    if (!labels.length) labels = null;
  }

  const o = raw.options && typeof raw.options === "object" ? raw.options : {};
  const options = {};
  if (o.legend !== undefined) {
    if (typeof o.legend === "string") {
      const lp = o.legend.toLowerCase();
      options.legend = ["top", "bottom", "left", "right"].includes(lp) ? lp : lp === "false" || lp === "none" ? false : "top";
    } else options.legend = o.legend ? "top" : false;
  }
  for (const k of ["stacked", "horizontal", "beginAtZero", "grid", "tooltips"]) {
    if (typeof o[k] === "boolean") options[k] = o[k];
  }
  for (const k of ["xLabel", "yLabel"]) {
    if (str(o[k])) options[k] = str(o[k]).slice(0, 60);
  }
  if (num(o.yMin) !== null) options.yMin = num(o.yMin);
  if (num(o.yMax) !== null) options.yMax = num(o.yMax);
  if (num(o.aspectRatio) !== null) options.aspectRatio = Math.max(0.5, Math.min(4, num(o.aspectRatio)));

  return {
    type: "chart",
    chartType: kind,
    ...(str(raw.title) ? { title: str(raw.title).slice(0, 160) } : {}),
    ...(str(raw.caption) ? { caption: str(raw.caption).slice(0, 300) } : {}),
    ...(labels ? { labels } : {}),
    datasets,
    ...(Object.keys(options).length ? { options } : {}),
    ...(controls ? { controls } : {}),
    ...(domain ? { domain } : {}),
  };
}

// What the model is told about chart widgets (mirrors normalizeChartWidget).
export function chartCatalogBlock(lang) {
  return `CHART WIDGET (type "chart"): a data or function chart rendered natively.
Shape: {"id":"chart-1","type":"chart","chartType":"<kind>","title"?,"caption"?,"labels"?:[...],"datasets":[...],"options"?:{...},"controls"?:[...],"domain"?:{...}}
chartType: line | bar | area | pie | doughnut | radar | polarArea | scatter | bubble | function | mixed.
- Category charts (line/bar/area/pie/doughnut/radar/polarArea): "labels":["Jan","Feb",...] and
  "datasets":[{"label":"Series A","data":[1,2,3],"color"?,"stack"?,"fill"?,"dashed"?,"type"? for mixed (bar|line)}].
- scatter / bubble: dataset "data":[{"x":1,"y":2,"r"?:5}].
- function (live, draggable): dataset "expr":"a*x*x + b*x + c" with "controls":[{"name":"a","label":"a","min":-3,"max":3,"step":0.1,"value":1}] (1-6 sliders)
  and "domain":{"min":-10,"max":10,"samples":120}. expr may use ONLY numbers, the domain var (default x),
  control names, + - * / ^ ( ), pi, e, and sin cos tan sqrt abs log exp round floor ceil (1 arg), min max pow (2 args).
options (optional): {"legend":"top|bottom|left|right|false","stacked":bool,"horizontal":bool,"beginAtZero":bool,"xLabel","yLabel","yMin","yMax"}.
Use a chart for REAL quantitative data or to illustrate a function/relationship — never invent fake numbers.
All learner-visible strings in language "${lang}". Place the marker ::widget{type="chart" id="chart-1"} in the article where the chart belongs.`;
}

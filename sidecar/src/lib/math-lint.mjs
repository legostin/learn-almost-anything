// Lightweight, dependency-free LaTeX sanity lint for generated articles.
//
// It is NOT a full LaTeX parser — it flags the breakages that actually show up
// in generated content (an unterminated math span, unbalanced { } braces) so the
// editor/review pass can repair them and so we can log when a draft ships broken
// math. Command-level correctness ("is \frac used right?") is left to the model
// (the authoring prompt requires valid KaTeX; the review pass re-checks).

// Math spans, ignoring escaped \$ . $$…$$ (display) is matched before $…$.
const MATH_RE = /(?<!\\)\$\$([\s\S]+?)\$\$|(?<!\\)\$([^\n$]+?)\$/g;

function bracesBalanced(s) {
  let depth = 0;
  for (const ch of s) {
    if (ch === "{") depth++;
    else if (ch === "}" && --depth < 0) return false;
  }
  return depth === 0;
}

/**
 * @param {string} article
 * @returns {{ ok: boolean, issues: { expr: string, problem: string }[] }}
 */
export function lintMath(article) {
  const issues = [];
  if (typeof article !== "string" || !article) return { ok: true, issues };

  // Drop fenced + inline code so $ inside code samples isn't read as math.
  const prose = article.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");

  // Each math span opens and closes with $, so unescaped $ must be even.
  const dollars = (prose.match(/(?<!\\)\$/g) || []).length;
  if (dollars % 2 !== 0) {
    issues.push({
      expr: "",
      problem: "odd number of unescaped $ delimiters — a math span is unterminated",
    });
  }

  let m;
  MATH_RE.lastIndex = 0;
  while ((m = MATH_RE.exec(prose))) {
    const body = m[1] != null ? m[1] : m[2];
    if (!body.trim()) {
      issues.push({ expr: "", problem: "empty math span ($$ or $$)" });
    } else if (!bracesBalanced(body)) {
      issues.push({ expr: body.trim().slice(0, 80), problem: "unbalanced { } braces" });
    }
  }
  return { ok: issues.length === 0, issues };
}

/** One-line human-readable summary of lint issues for an LLM repair prompt. */
export function describeMathIssues(issues) {
  return issues
    .map((i) => (i.expr ? `"${i.expr}" (${i.problem})` : i.problem))
    .join("; ");
}

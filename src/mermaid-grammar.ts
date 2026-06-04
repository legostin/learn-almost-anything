// Mermaid grammar for highlight.js / lowlight.
//
// Vendored from lowlight-mermaid (react18-tools/lowlight-mermaid),
// https://github.com/react18-tools/lowlight-mermaid — licensed MPL-2.0.
// This file is governed by the Mozilla Public License 2.0; a copy is available
// at https://mozilla.org/MPL/2.0/.
//
// Local modification: the YAML front-matter rule (see below) is changed from
// the upstream begin/end pair — whose end never matched, swallowing the whole
// diagram into one `meta` blob — to a single self-contained match.
//
// Reference: https://mermaid.js.org/intro/syntax-reference.html

import type { HLJSApi, Language } from "highlight.js";

export const mermaidGrammar = (hljs: HLJSApi): Language => ({
  name: "Mermaid",
  aliases: ["mermaid"],
  case_insensitive: true,
  contains: [
    /**
     * Comments
     * Mermaid uses `%%` for line comments.
     */
    hljs.COMMENT(/%%/, /$/),

    /**
     * Directives
     * Block-style config like: %%{ init: { "theme": "dark" } }%%
     * Highlight the whole directive as `meta`,
     * with keys and values tokenized inside.
     */
    {
      className: "meta",
      begin: /%%\{/,
      end: /\}%%/,
      contains: [
        {
          className: "attr",
          begin: /[A-Za-z][A-Za-z0-9_-]*(?=\s*:)/,
        },
        {
          className: "string",
          begin: /:\s*/,
          end: /(?=(,\s*[A-Za-z]|$))/,
          excludeBegin: true,
        },
      ],
    },

    /**
     * YAML frontmatter
     * Optional config section at the top, delimited by --- lines.
     * Local fix: single self-contained match so the closing --- is found and the
     * rest of the diagram is not swallowed (see header note).
     */
    {
      className: "meta",
      begin: /^---\n[\s\S]*?\n---(?:\n|$)/,
    },

    /**
     * Diagram keywords
     * Cover all supported diagram types and optional direction (LR, TB, RL, BT).
     */
    {
      className: "keyword",
      begin:
        /\b(?:flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|pie|gantt|requirement|sankey|timeline|quadrant)(?:\s+(?:LR|TB|RL|BT))?\b/,
    },

    /**
     * Connectors / edges
     * Flow arrows, class/ER relationships, lifeline arrows, etc.
     */
    {
      className: "operator",
      begin:
        /(?:-->|---|-\.-|==>|<-+>|o--o|x--x|\|>|<\||<-->|==|--\||\|--|->>|-->>|<\|--|\*--|:>|o\{--|\}o--)/,
    },

    /**
     * Sequence diagram messages
     * Example: A->>B: message text
     */
    {
      className: "meta",
      begin: /\b[A-Za-z0-9_]+\s*-[->]+[A-Za-z0-9_]+\s*:/,
      end: /$/,
      contains: [
        {
          className: "string",
          begin: /:\s*/,
          end: /$/,
          excludeBegin: true,
        },
      ],
    },

    /**
     * Node shapes
     * Rectangles, rounds, circles, diamonds, trapezoids, links, etc.
     */
    {
      className: "string",
      variants: [
        { begin: /\[[^\]]+\]/ }, // [rect]
        { begin: /\([^)]+\)/ }, // (round)
        { begin: /\(\([^)]+\)\)/ }, // ((circle))
        { begin: /\{[^}]+\}/ }, // {diamond}
        { begin: />[^<]+</ }, // >trapezoid<
        { begin: /\[\[[^\]]+\]\]/ }, // [[link]]
      ],
    },

    /**
     * Notes
     * Example: note left of A: This is a note
     */
    {
      className: "string",
      begin: /note\s+(?:left|right|top|bottom)\s+of\s+[A-Za-z0-9_]+/i,
    },

    /**
     * Identifiers / labels
     * Node IDs or barewords.
     */
    {
      className: "title",
      begin: /\b[A-Za-z0-9_]+\b/,
    },

    /**
     * Quoted text
     * Often used for labels or annotations.
     */
    {
      className: "string",
      begin: /".*?"/,
    },

    /**
     * Numbers
     * Common in gantt/journey/timeline diagrams.
     */
    {
      className: "number",
      begin: /\b\d+([:.]\d+)?\b/,
    },

    /**
     * Punctuation
     * Structural tokens that aren’t part of identifiers or shapes.
     */
    {
      className: "punctuation",
      begin: /[:;#{}[\]()]/,
    },
  ],
});

import { Node, mergeAttributes, nodeInputRule } from "@tiptap/core";
import { ReactNodeViewRenderer, NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import katex from "katex";

// markdown-it state we touch (kept minimal — markdown-it has no bundled types here).
type InlineState = {
  src: string;
  pos: number;
  posMax: number;
  push: (type: string, tag: string, nesting: number) => { content: string; markup: string; meta: unknown };
};
type MarkdownIt = {
  inline: { ruler: { before: (n: string, name: string, fn: (s: InlineState, silent: boolean) => boolean) => void } };
  renderer: { rules: Record<string, (tokens: { content: string; meta: { display: boolean } }[], idx: number) => string> };
};

// Inline rule: tokenize $…$ (inline) and $$…$$ (display) capturing the RAW LaTeX
// BEFORE markdown-it's emphasis/escape rules can mangle it (underscores become
// <em>, backslashes get doubled). Registered before "emphasis" (i.e. after the
// escape rule), so an escaped \$ never opens math.
function mathRule(state: InlineState, silent: boolean): boolean {
  if (state.src.charCodeAt(state.pos) !== 0x24 /* $ */) return false;
  const display = state.src.charCodeAt(state.pos + 1) === 0x24;
  const marker = display ? "$$" : "$";
  const start = state.pos + marker.length;
  const end = state.src.indexOf(marker, start);
  if (end < 0) return false;
  const content = state.src.slice(start, end);
  if (!content.trim()) return false;
  if (!silent) {
    const token = state.push("math", "", 0);
    token.content = content;
    token.markup = marker;
    token.meta = { display };
  }
  state.pos = end + marker.length;
  return true;
}

const escAttr = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function mathItPlugin(md: MarkdownIt): void {
  md.inline.ruler.before("emphasis", "math", mathRule);
  md.renderer.rules.math = (tokens, idx) => {
    const t = tokens[idx];
    const display = t.meta?.display ? "true" : "false";
    // Raw LaTeX carried in an attribute; DOMParser un-escapes it back to raw on parse.
    return `<span data-math="" data-display="${display}" data-latex="${escAttr(t.content)}"></span>`;
  };
}

function MathView(props: ReactNodeViewProps) {
  const latex = (props.node.attrs.latex as string) || "";
  const display = !!props.node.attrs.display;
  let html = "";
  try {
    html = katex.renderToString(latex, { displayMode: display, throwOnError: false, output: "html" });
  } catch {
    html = "";
  }
  return (
    <NodeViewWrapper
      as={display ? "div" : ("span" as "div")}
      className={`we-math${display ? " we-math-block" : ""}${props.selected ? " selected" : ""}`}
      contentEditable={false}
      title={latex}
    >
      {html ? (
        <span dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <span className="we-math-raw">{`${display ? "$$" : "$"}${latex}${display ? "$$" : "$"}`}</span>
      )}
    </NodeViewWrapper>
  );
}

// Inline atom node for LaTeX math. Loaded $…$ / $$…$$ round-trip VERBATIM (the
// serializer writes the raw LaTeX with no markdown escaping), rendered live with
// KaTeX. This is the fix for the beta editor corrupting math on save.
export const MathNode = Node.create({
  name: "math",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      latex: { default: "" },
      display: { default: false },
    };
  },

  addStorage() {
    return {
      markdown: {
        serialize(
          state: { write: (s: string) => void },
          node: { attrs: { latex: string; display: boolean } }
        ) {
          const m = node.attrs.display ? "$$" : "$";
          state.write(`${m}${node.attrs.latex ?? ""}${m}`);
        },
        parse: {
          setup(markdownit: MarkdownIt) {
            mathItPlugin(markdownit);
          },
        },
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: "span[data-math]",
        getAttrs: (el) => ({
          latex: (el as HTMLElement).getAttribute("data-latex") || "",
          display: (el as HTMLElement).getAttribute("data-display") === "true",
        }),
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-math": "",
        "data-display": HTMLAttributes.display ? "true" : "false",
        "data-latex": HTMLAttributes.latex,
      }),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(MathView);
  },

  // Live conversion while typing. Display ($$…$$) is tried first; the inline
  // rule's negative lookbehind keeps it from firing mid-way through "$$…$".
  addInputRules() {
    return [
      nodeInputRule({
        find: /\$\$([^$\n]+)\$\$$/,
        type: this.type,
        getAttributes: (m) => ({ latex: m[1], display: true }),
      }),
      nodeInputRule({
        find: /(?<!\$)\$([^$\n]+)\$$/,
        type: this.type,
        getAttributes: (m) => ({ latex: m[1], display: false }),
      }),
    ];
  },
});

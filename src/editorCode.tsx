import { common, createLowlight } from "lowlight";
import { CodeBlockLowlight } from "@tiptap/extension-code-block-lowlight";
import { ReactNodeViewRenderer, NodeViewWrapper, NodeViewContent, type ReactNodeViewProps } from "@tiptap/react";

const lowlight = createLowlight(common);

// Languages offered in the picker. lowlight's `common` bundle covers these;
// unknown ones fall back to plain text. The value is stored as the code fence
// language so it round-trips to ```<lang>.
const LANGS = [
  "plaintext",
  "bash",
  "c",
  "cpp",
  "csharp",
  "css",
  "go",
  "html",
  "java",
  "javascript",
  "json",
  "markdown",
  "python",
  "rust",
  "sql",
  "typescript",
  "yaml",
];

function CodeBlockView(props: ReactNodeViewProps) {
  const language = (props.node.attrs.language as string) || "plaintext";
  return (
    <NodeViewWrapper className="we-code-block">
      <div className="we-code-head" contentEditable={false}>
        <select
          className="we-code-lang"
          value={LANGS.includes(language) ? language : "plaintext"}
          onChange={(e) => props.updateAttributes({ language: e.target.value })}
        >
          {LANGS.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      </div>
      <pre>
        <NodeViewContent as={"code" as "div"} className={`language-${language}`} />
      </pre>
    </NodeViewWrapper>
  );
}

// Syntax-highlighted code block (lowlight/highlight.js) with an in-block
// language picker. Replaces StarterKit's plain code block in the editor.
export const CodeBlock = CodeBlockLowlight.extend({
  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockView);
  },
}).configure({ lowlight, defaultLanguage: "plaintext" });

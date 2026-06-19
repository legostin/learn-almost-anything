import { useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";
import { useT } from "./i18n";

// LEG-21 — inline WYSIWYG block editor (Tiptap). First cut: edits the article's
// prose directly in the rendered layout (headings, paragraphs, lists, quotes,
// code) and round-trips through markdown. Widgets (::widget{...} marker lines)
// and math ($…$) are preserved verbatim as markdown text — full per-widget
// block editing, the "/" slash menu and per-block AI land in following steps.
// Wired opt-in (beta) so the existing editor keeps working while this matures.
export function BlockEditor({
  article,
  busy,
  onSave,
  onClose,
}: {
  article: string;
  busy?: boolean;
  onSave: (markdown: string) => void | Promise<void>;
  onClose: () => void;
}) {
  const t = useT();
  const [saving, setSaving] = useState(false);
  const editor = useEditor({
    extensions: [
      StarterKit,
      Markdown.configure({
        html: false,
        tightLists: true,
        linkify: false,
        breaks: false,
        transformPastedText: true,
      }),
    ],
    content: article,
  });

  const save = async () => {
    if (!editor || saving) return;
    setSaving(true);
    try {
      const md = (editor.storage as unknown as { markdown: { getMarkdown(): string } }).markdown.getMarkdown();
      await onSave(md);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="block-editor">
      <div className="block-editor-bar">
        <span className="block-editor-badge">beta</span>
        <span className="block-editor-spacer" />
        <button className="ghost" onClick={onClose} disabled={saving}>
          {t("cancel")}
        </button>
        <button onClick={save} disabled={saving || busy}>
          {saving ? t("saving") : t("editorSave")}
        </button>
      </div>
      <EditorContent editor={editor} className="block-editor-content" />
    </div>
  );
}

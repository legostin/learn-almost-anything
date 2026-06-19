import { useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";
import Placeholder from "@tiptap/extension-placeholder";
import { SlashCommands, type SlashCommand } from "./editorSlash";
import { useT, useLang } from "./i18n";

// Localized "/" command labels (kept here rather than i18n.tsx to avoid dozens
// of one-off keys; the editor is the only consumer).
const SLASH_LABELS = {
  ru: {
    text: ["Текст", "Обычный абзац"],
    h1: ["Заголовок 1", "Крупный заголовок"],
    h2: ["Заголовок 2", "Средний заголовок"],
    h3: ["Заголовок 3", "Небольшой заголовок"],
    ul: ["Маркированный список", "Список с точками"],
    ol: ["Нумерованный список", "Список 1, 2, 3"],
    quote: ["Цитата", "Блок цитаты"],
    code: ["Код", "Блок кода"],
    hr: ["Разделитель", "Горизонтальная линия"],
  },
  en: {
    text: ["Text", "Plain paragraph"],
    h1: ["Heading 1", "Large heading"],
    h2: ["Heading 2", "Medium heading"],
    h3: ["Heading 3", "Small heading"],
    ul: ["Bulleted list", "List with bullets"],
    ol: ["Numbered list", "List 1, 2, 3"],
    quote: ["Quote", "Block quote"],
    code: ["Code", "Code block"],
    hr: ["Divider", "Horizontal rule"],
  },
} as const;

function buildSlashCommands(lang: "ru" | "en"): SlashCommand[] {
  const L = SLASH_LABELS[lang] ?? SLASH_LABELS.en;
  const mk = (key: keyof typeof L, keywords: string, run: SlashCommand["run"]): SlashCommand => ({
    title: L[key][0],
    hint: L[key][1],
    keywords,
    run,
  });
  return [
    mk("text", "text paragraph текст абзац", (e, r) =>
      e.chain().focus().deleteRange(r).setNode("paragraph").run()
    ),
    mk("h1", "h1 heading заголовок", (e, r) =>
      e.chain().focus().deleteRange(r).setNode("heading", { level: 1 }).run()
    ),
    mk("h2", "h2 heading заголовок", (e, r) =>
      e.chain().focus().deleteRange(r).setNode("heading", { level: 2 }).run()
    ),
    mk("h3", "h3 heading заголовок", (e, r) =>
      e.chain().focus().deleteRange(r).setNode("heading", { level: 3 }).run()
    ),
    mk("ul", "bullet list unordered список маркир", (e, r) =>
      e.chain().focus().deleteRange(r).toggleBulletList().run()
    ),
    mk("ol", "ordered numbered list нумерованный список", (e, r) =>
      e.chain().focus().deleteRange(r).toggleOrderedList().run()
    ),
    mk("quote", "quote blockquote цитата", (e, r) =>
      e.chain().focus().deleteRange(r).toggleBlockquote().run()
    ),
    mk("code", "code block код", (e, r) =>
      e.chain().focus().deleteRange(r).toggleCodeBlock().run()
    ),
    mk("hr", "divider horizontal rule разделитель линия", (e, r) =>
      e.chain().focus().deleteRange(r).setHorizontalRule().run()
    ),
  ];
}

// LEG-21 — inline WYSIWYG block editor (Tiptap). Edits article prose directly in
// the rendered layout, with a "/" slash menu to insert blocks. Round-trips
// through markdown; ::widget markers + math are preserved verbatim as text for
// now (rich per-widget block editing is the next step).
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
  const [lang] = useLang();
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
      Placeholder.configure({
        includeChildren: false,
        placeholder: ({ node }) =>
          node.type.name === "paragraph" ? t("editorSlashHint") : "",
      }),
      SlashCommands.configure({ commands: buildSlashCommands(lang === "ru" ? "ru" : "en") }),
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
        <span className="block-editor-hint">{t("editorSlashHint")}</span>
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

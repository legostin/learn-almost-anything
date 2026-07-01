import { useEffect, useRef, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import { CodeBlock } from "./editorCode";
import { Markdown } from "tiptap-markdown";
import Placeholder from "@tiptap/extension-placeholder";
import { type Editor } from "@tiptap/core";
import { SlashCommands, type SlashCommand } from "./editorSlash";
import { WidgetNode, WIDGET_TYPES, newWidgetId, defaultWidgetData } from "./editorWidget";
import { MathNode } from "./editorMath";
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
    table: ["Таблица", "Таблица 3×3"],
    image: ["Изображение", "Картинка с поиском/загрузкой"],
    gallery: ["Галерея", "Несколько изображений"],
    diagram: ["Диаграмма", "Mermaid-схема"],
    video: ["Видео", "Встроенное видео"],
    interactive: ["Интерактив", "Интерактивный виджет"],
    checkpoint: ["Проверка", "Вопрос для самопроверки"],
    recall: ["Карточка", "Карточка для запоминания"],
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
    table: ["Table", "3×3 table"],
    image: ["Image", "Picture with search/upload"],
    gallery: ["Gallery", "Multiple images"],
    diagram: ["Diagram", "Mermaid chart"],
    video: ["Video", "Embedded video"],
    interactive: ["Interactive", "Interactive widget"],
    checkpoint: ["Checkpoint", "Self-check question"],
    recall: ["Recall card", "Memory card"],
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
  const insertWidget = (wtype: string): SlashCommand["run"] => (e, r) => {
    const id = newWidgetId(wtype);
    const store = (e.storage as unknown as { widget: { widgets: Record<string, unknown> } }).widget
      .widgets;
    store[id] = defaultWidgetData(wtype);
    e.chain().focus().deleteRange(r).insertContent({ type: "widget", attrs: { id, wtype } }).run();
  };
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
    mk("table", "table таблица", (e, r) =>
      e.chain().focus().deleteRange(r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
    ),
    mk("image", "image picture изображение картинка фото", insertWidget("image")),
    mk("gallery", "gallery images галерея изображения", insertWidget("gallery")),
    mk("diagram", "diagram mermaid диаграмма схема", insertWidget("diagram")),
    mk("video", "video видео ролик", insertWidget("video")),
    mk("interactive", "interactive widget интерактив виджет", insertWidget("interactive")),
    mk("checkpoint", "checkpoint question проверка вопрос", insertWidget("checkpoint")),
    mk("recall", "recall flashcard карточка запоминание", insertWidget("recall")),
  ];
}

// Encyclopedia cross-links are stored as `[Title](course://article/<raw title>)`
// with the raw, space-containing title left in the href. markdown-it (the editor's
// markdown parser) treats a destination containing spaces as invalid and leaves
// the whole link as literal text, so the editor rendered `[Title](course://…)`
// raw instead of as a link. Percent-encode the href on the way INTO the editor so
// it parses as a link…
function encodeArticleLinkHrefs(md: string): string {
  return String(md || "").replace(
    /\]\(course:\/\/article\/([^)]+)\)/gi,
    (_full, raw: string) => `](course://article/${encodeURIComponent(raw.trim())})`
  );
}

// …and decode it back on the way OUT so the stored markdown keeps its canonical
// raw form (matching the generator and the reader, whose own encoder would
// otherwise double-encode it). Defensive: a stray `%` makes decode throw, so the
// href is left untouched in that case.
function decodeArticleLinkHrefs(md: string): string {
  return String(md || "").replace(
    /\]\(course:\/\/article\/([^)]+)\)/gi,
    (_full, raw: string) => {
      let title = raw.trim();
      try {
        title = decodeURIComponent(title);
      } catch {
        /* leave as-is */
      }
      return `](course://article/${title})`;
    }
  );
}

function editorMarkdown(editor: Editor): string {
  const md = (editor.storage as unknown as { markdown: { getMarkdown(): string } }).markdown.getMarkdown();
  return decodeArticleLinkHrefs(md);
}

// markdown-it merges a `::widget{…}` marker into an adjacent paragraph when it's
// only single-newline separated, which hides it from WidgetNode's parser; on save
// referencedWidgets then prunes its data. Surround each STANDALONE marker line
// with blank lines so it parses as its own block. Operates line-by-line and skips
// fenced code blocks, so a literal `::widget{…}` inside prose or a code sample is
// left untouched (otherwise it would split prose or alter code on save).
function isolateWidgetMarkers(md: string): string {
  const out: string[] = [];
  let inFence = false;
  for (const line of md.split("\n")) {
    const t = line.trim();
    if (/^(```|~~~)/.test(t)) {
      inFence = !inFence;
      out.push(line);
    } else if (!inFence && /^::widget\{[^}]*\}$/.test(t)) {
      if (out.length && out[out.length - 1].trim() !== "") out.push("");
      out.push(t);
      out.push("");
    } else {
      out.push(line);
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
}

// Widgets still referenced by a node in the doc (drop deleted ones).
function referencedWidgets(editor: Editor, store: Record<string, unknown>): Record<string, unknown> {
  const ids = new Set<string>();
  editor.state.doc.descendants((node) => {
    if (node.type.name === "widget" && node.attrs.id) ids.add(node.attrs.id as string);
  });
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(store)) if (ids.has(k)) out[k] = v;
  return out;
}

type WidgetTarget = { widgetId: string; widgetType: string; summary: string; imagePath?: string };
type WidgetStorage = {
  widgets: Record<string, unknown>;
  ctx?: { courseId: string; moduleId: string; submoduleId: string };
  canGenerate?: boolean;
  persistNow?: () => Promise<void>;
  readWidgets?: () => Promise<Record<string, unknown>>;
  askAssistant?: (target: WidgetTarget) => void;
};

// LEG-21 — inline WYSIWYG block editor (Tiptap). Edits article prose directly in
// the rendered layout with a "/" slash menu to insert blocks AND widgets (image,
// gallery, diagram, video, interactive, checkpoint, recall). Widgets round-trip
// to ::widget markers; their data is carried in editor storage and returned on
// save. Per-widget configuration (image search/upload, source, fixes) is next.
export function BlockEditor({
  article,
  widgets,
  ctx,
  canGenerate,
  busy,
  onSave,
  onPersist,
  onReadWidgets,
  onAskAssistant,
  onAskWidget,
  reloadKey,
  onClose,
}: {
  article: string;
  widgets: Record<string, unknown>;
  ctx: { courseId: string; moduleId: string; submoduleId: string };
  canGenerate: boolean;
  busy?: boolean;
  onSave: (markdown: string, widgets: Record<string, unknown>) => void | Promise<void>;
  // Save the current article+widgets to disk WITHOUT closing (so a widget's
  // backend image/AI op can read it), and re-read widget data after the op.
  onPersist: (markdown: string, widgets: Record<string, unknown>) => Promise<void>;
  onReadWidgets: () => Promise<Record<string, unknown>>;
  // Open the course assistant focused on the selected text (replaces the old
  // one-shot edit_text). The editor persists the draft first so the assistant
  // operates on current content.
  onAskAssistant: (selection: string) => void | Promise<void>;
  // Open the assistant focused on a widget (editor "✨ ИИ" on a widget block).
  onAskWidget: (target: WidgetTarget) => void;
  // Bumped by the parent after the assistant changes the lesson; the editor
  // reloads the article + widgets to reflect it.
  reloadKey?: number;
  onClose: () => void;
}) {
  const t = useT();
  const [lang] = useLang();
  const [saving, setSaving] = useState(false);
  const editor = useEditor({
    extensions: [
      // Allow the "course://" scheme so documentation cross-links
      // [Title](course://article/<Title>) survive parsing instead of being
      // stripped by the link extension's default protocol allow-list.
      StarterKit.configure({ codeBlock: false, link: { protocols: ["course"] } }),
      TableKit,
      CodeBlock,
      WidgetNode,
      MathNode,
      Markdown.configure({
        html: false,
        tightLists: true,
        linkify: false,
        breaks: false,
        transformPastedText: true,
      }),
      Placeholder.configure({
        includeChildren: false,
        placeholder: ({ node }) => (node.type.name === "paragraph" ? t("editorSlashHint") : ""),
      }),
      SlashCommands.configure({ commands: buildSlashCommands(lang === "ru" ? "ru" : "en") }),
    ],
    content: "",
  });

  // Load widget data into editor storage, then parse the article (so widget
  // node-views can resolve their data). Once per open.
  useEffect(() => {
    if (!editor) return;
    const api = (editor.storage as unknown as { widget: WidgetStorage }).widget;
    api.widgets = { ...widgets };
    api.ctx = ctx;
    api.canGenerate = canGenerate;
    api.persistNow = async () => {
      await onPersist(editorMarkdown(editor), referencedWidgets(editor, api.widgets));
    };
    api.readWidgets = onReadWidgets;
    api.askAssistant = (target) => onAskWidget(target);
    try {
      editor.commands.setContent(encodeArticleLinkHrefs(isolateWidgetMarkers(article)));
    } catch (e) {
      // Surface the real parse failure, then let the error boundary fall back to
      // the classic editor (where the unparsed article is safe) instead of saving
      // empty content over it.
      console.error("[BlockEditor] setContent failed", e);
      throw e;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  // After the assistant edits the lesson the parent bumps reloadKey; reload the
  // article + widgets so the editor reflects the change (the draft was persisted
  // before the assistant ran, so nothing unsaved is lost). The first observed
  // value just initializes the baseline — it never re-loads on mount.
  const lastReloadKey = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!editor) return;
    if (lastReloadKey.current === undefined || reloadKey === lastReloadKey.current) {
      lastReloadKey.current = reloadKey;
      return;
    }
    lastReloadKey.current = reloadKey;
    const api = (editor.storage as unknown as { widget: WidgetStorage }).widget;
    api.widgets = { ...widgets };
    try {
      editor.commands.setContent(encodeArticleLinkHrefs(isolateWidgetMarkers(article)));
    } catch (e) {
      console.error("[BlockEditor] reload setContent failed", e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, reloadKey]);

  const save = async () => {
    if (!editor || saving) return;
    setSaving(true);
    try {
      const md = editorMarkdown(editor);
      const store = (editor.storage as unknown as { widget: WidgetStorage }).widget.widgets;
      await onSave(md, referencedWidgets(editor, store));
    } finally {
      setSaving(false);
    }
  };

  // Selection AI: hand the selected text to the course assistant's full chat
  // interface (instead of a silent one-shot edit). Persist the current draft so
  // the assistant works on up-to-date content; the editor reloads via reloadKey
  // once the assistant applies a change.
  const openAssistant = async () => {
    if (!editor) return;
    const { from, to } = editor.state.selection;
    const selection = editor.state.doc.textBetween(from, to, "\n").trim();
    if (!selection) return;
    const store = (editor.storage as unknown as { widget: WidgetStorage }).widget.widgets;
    await onPersist(editorMarkdown(editor), referencedWidgets(editor, store));
    await onAskAssistant(selection);
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
      {editor && (
        <BubbleMenu
          editor={editor}
          options={{ placement: "bottom-start", offset: 8 }}
          className="bubble-menu"
        >
          <button
            className={editor.isActive("bold") ? "active" : ""}
            title="Жирный"
            onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleBold().run(); }}
          >
            <b>B</b>
          </button>
          <button
            className={editor.isActive("italic") ? "active" : ""}
            title="Курсив"
            onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleItalic().run(); }}
          >
            <i>I</i>
          </button>
          <button
            className={editor.isActive("code") ? "active" : ""}
            title="Код"
            onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleCode().run(); }}
          >
            {"</>"}
          </button>
          <button
            className={editor.isActive("heading", { level: 2 }) ? "active" : ""}
            title="Заголовок"
            onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleHeading({ level: 2 }).run(); }}
          >
            H
          </button>
          <button
            className={editor.isActive("blockquote") ? "active" : ""}
            title="Цитата"
            onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleBlockquote().run(); }}
          >
            ❝
          </button>
          <button
            className="bubble-ai-btn"
            title="Открыть ассистента для этого фрагмента"
            onMouseDown={(e) => { e.preventDefault(); void openAssistant(); }}
          >
            ✨ ИИ
          </button>
        </BubbleMenu>
      )}
      <EditorContent editor={editor} className="block-editor-content" />
    </div>
  );
}

export { WIDGET_TYPES };

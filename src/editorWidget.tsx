import { useState } from "react";
import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer, NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { ImageItemEditor, DiagramWidget, resolveWidgetImage } from "./App";

// Widget types in the article model (mirrors WidgetData in App.tsx).
export const WIDGET_TYPES = [
  "image",
  "gallery",
  "diagram",
  "video",
  "interactive",
  "checkpoint",
  "recall",
] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];

export function newWidgetId(wtype: string): string {
  const rnd = Math.floor((1 + Math.sin(Date.now() % 100000) * 0.5 + Math.random()) * 1e8)
    .toString(16)
    .slice(0, 8);
  return `usr-${wtype}-${rnd}`;
}

// Starter shapes for a freshly-inserted widget (mirrors defaultWidget in App.tsx).
export function defaultWidgetData(wtype: string): Record<string, unknown> {
  switch (wtype) {
    case "image":
      return { type: "image", placeholder: true, description: "", source: "" };
    case "gallery":
      return { type: "gallery", caption: "", items: [] };
    case "diagram":
      return { type: "diagram", source: "graph TD;\n  A[Start] --> B[End];", caption: "" };
    case "video":
      return { type: "video", url: "", title: "" };
    case "interactive":
      return { type: "interactive", title: "", description: "" };
    case "checkpoint":
      return { type: "checkpoint", question: "", answer: "" };
    case "recall":
      return { type: "recall", question: "", answer: "" };
    default:
      return { type: wtype };
  }
}

const parseParam = (params: string, key: string): string => {
  const m = params.match(new RegExp(`${key}="([^"]*)"`));
  return m ? m[1] : "";
};

const imgSrcOf = (url: unknown, source?: unknown): string =>
  resolveWidgetImage(
    typeof url === "string" ? url : undefined,
    typeof source === "string" ? source : undefined
  ).imgSrc;

type AnyData = Record<string, unknown>;
type RunHeavy = (op: () => Promise<void>, opts?: { refresh?: boolean }) => Promise<void>;

// Shared state/callbacks the editor exposes to widget node-views via
// editor.storage.widget (set by BlockEditor on open).
type WidgetApi = {
  widgets: Record<string, AnyData>;
  ctx?: { courseId: string; moduleId: string; submoduleId: string };
  canGenerate?: boolean;
  persistNow?: () => Promise<void>;
  readWidgets?: () => Promise<Record<string, AnyData>>;
};

function Field({
  label,
  value,
  onChange,
  area,
  placeholder,
}: {
  label: string;
  value: unknown;
  onChange: (v: string) => void;
  area?: boolean;
  placeholder?: string;
}) {
  const v = typeof value === "string" ? value : value == null ? "" : String(value);
  return (
    <label className="we-field">
      <span className="we-field-label">{label}</span>
      {area ? (
        <textarea value={v} rows={3} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input value={v} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      )}
    </label>
  );
}

function WidgetPreview({ id, wtype, w }: { id: string; wtype: string; w: AnyData }) {
  if (wtype === "image") {
    const src = imgSrcOf(w.url, w.source);
    return src ? (
      <img className="we-img" src={src} alt={(w.alt as string) || ""} />
    ) : (
      <span className="we-muted">🖼 {(w.description as string) || "Изображение — нажмите, чтобы настроить"}</span>
    );
  }
  if (wtype === "gallery") {
    const items = Array.isArray(w.items) ? (w.items as AnyData[]) : [];
    return (
      <div className="we-gallery">
        {items.slice(0, 6).map((it, i) => {
          const src = imgSrcOf(it.url, it.source);
          return src ? <img key={i} src={src} alt="" /> : <span key={i} className="we-cell" />;
        })}
        {!items.length && <span className="we-muted">🖼 Галерея — нажмите, чтобы настроить</span>}
      </div>
    );
  }
  if (wtype === "diagram") {
    const src = typeof w.source === "string" ? w.source : "";
    return src.trim() ? (
      <DiagramWidget id={id} widget={{ source: src, caption: w.caption as string, error: w.error as string }} />
    ) : (
      <span className="we-muted">📊 Диаграмма — нажмите, чтобы настроить</span>
    );
  }
  if (wtype === "video")
    return <span className="we-muted">▶ {(w.title as string) || (w.url as string) || "Видео"}</span>;
  if (wtype === "interactive")
    return <span className="we-muted">🧩 {(w.title as string) || "Интерактив"}</span>;
  if (wtype === "checkpoint" || wtype === "recall")
    return <span className="we-muted">❓ {(w.question as string) || "Вопрос"}</span>;
  return <span className="we-muted">{wtype}</span>;
}

function WidgetForm({
  wtype,
  id,
  w,
  set,
  ctx,
  canGenerate,
  busy,
  runHeavy,
}: {
  wtype: string;
  id: string;
  w: AnyData;
  set: (f: AnyData) => void;
  ctx: { courseId: string; moduleId: string; submoduleId: string };
  canGenerate: boolean;
  busy: boolean;
  runHeavy: RunHeavy;
}) {
  const baseArgs = { ...ctx, widgetId: id };

  if (wtype === "image") {
    return (
      <ImageItemEditor
        args={baseArgs}
        imgSrc={imgSrcOf(w.url, w.source)}
        alt={w.alt as string}
        description={w.description as string}
        onDescriptionChange={(v) => set({ description: v })}
        cachedQuery={w.query as string}
        onQueryResolved={(query) => set({ query })}
        canGenerate={canGenerate}
        busy={busy}
        runHeavy={runHeavy}
      />
    );
  }

  if (wtype === "gallery") {
    const items = Array.isArray(w.items) ? (w.items as AnyData[]) : [];
    const setItem = (i: number, f: AnyData) =>
      set({ items: items.map((it, j) => (j === i ? { ...it, ...f } : it)) });
    return (
      <>
        <Field label="Подпись галереи" value={w.caption} onChange={(v) => set({ caption: v })} />
        {items.map((it, i) => (
          <ImageItemEditor
            key={i}
            args={baseArgs}
            itemIndex={i}
            imgSrc={imgSrcOf(it.url, it.source)}
            alt={it.alt as string}
            description={it.description as string}
            onDescriptionChange={(v) => setItem(i, { description: v })}
            cachedQuery={it.query as string}
            onQueryResolved={(query) => setItem(i, { query })}
            canGenerate={canGenerate}
            busy={busy}
            runHeavy={runHeavy}
            onDelete={() => set({ items: items.filter((_, j) => j !== i) })}
          />
        ))}
        <button
          type="button"
          className="we-add"
          disabled={busy}
          onClick={() => set({ items: [...items, { placeholder: true }] })}
        >
          + Изображение
        </button>
      </>
    );
  }

  if (wtype === "diagram") {
    const src = typeof w.source === "string" ? w.source : "";
    return (
      <>
        <Field label="Mermaid-код" value={w.source} area onChange={(v) => set({ source: v })} />
        {src.trim() && (
          <DiagramWidget id={id} widget={{ source: src, caption: w.caption as string, error: w.error as string }} />
        )}
        <Field label="Подпись" value={w.caption} onChange={(v) => set({ caption: v })} />
      </>
    );
  }
  if (wtype === "video") {
    return (
      <>
        <Field label="URL (YouTube/Vimeo)" value={w.url} onChange={(v) => set({ url: v })} />
        <Field label="Название" value={w.title} onChange={(v) => set({ title: v })} />
        <Field label="Почему стоит посмотреть" value={w.why} onChange={(v) => set({ why: v })} />
        <Field label="Начало (сек)" value={w.start} onChange={(v) => set({ start: v })} />
        <Field label="Конец (сек)" value={w.end} onChange={(v) => set({ end: v })} />
        <Field label="На что обратить внимание" value={w.focus} onChange={(v) => set({ focus: v })} />
      </>
    );
  }
  if (wtype === "interactive") {
    const legacy = typeof w.html === "string" || typeof w.css === "string" || typeof w.js === "string";
    return (
      <>
        <Field label="Заголовок" value={w.title} onChange={(v) => set({ title: v })} />
        <Field label="Описание" value={w.description} area onChange={(v) => set({ description: v })} />
        {legacy ? (
          <>
            <Field label="HTML" value={w.html} area onChange={(v) => set({ html: v })} />
            <Field label="CSS" value={w.css} area onChange={(v) => set({ css: v })} />
            <Field label="JS" value={w.js} area onChange={(v) => set({ js: v })} />
          </>
        ) : (
          <>
            <Field label="Шаблон" value={w.template} onChange={(v) => set({ template: v })} />
            <Field
              label="Параметры (JSON)"
              value={typeof w.params === "string" ? w.params : JSON.stringify(w.params ?? {}, null, 2)}
              area
              onChange={(v) => {
                try {
                  set({ params: JSON.parse(v) });
                } catch {
                  set({ params: v });
                }
              }}
            />
          </>
        )}
      </>
    );
  }
  if (wtype === "checkpoint" || wtype === "recall") {
    return (
      <>
        <Field label="Вопрос" value={w.question} area onChange={(v) => set({ question: v })} />
        <Field label="Ответ" value={w.answer} area onChange={(v) => set({ answer: v })} />
      </>
    );
  }
  return <span className="we-muted">Нет настроек для «{wtype}»</span>;
}

function WidgetBlockView(props: ReactNodeViewProps) {
  const id = props.node.attrs.id as string;
  const wtype = props.node.attrs.wtype as string;
  const api = (props.editor.storage as unknown as { widget?: WidgetApi }).widget;
  const store = api?.widgets ?? {};
  const [, force] = useState(0);
  const [busy, setBusy] = useState(false);
  const w: AnyData = store[id] ?? {};

  const set = (fields: AnyData) => {
    store[id] = { ...(store[id] ?? {}), ...fields };
    force((x) => x + 1);
  };

  // Persist current state → run a backend image/AI op → re-read widget data.
  const runHeavy: RunHeavy = async (op, opts) => {
    setBusy(true);
    try {
      await api?.persistNow?.();
      await op();
      if (opts?.refresh !== false && api?.readWidgets) {
        const fresh = await api.readWidgets();
        Object.assign(store, fresh);
        force((x) => x + 1);
      }
    } finally {
      setBusy(false);
    }
  };

  const ctx = api?.ctx ?? { courseId: "", moduleId: "", submoduleId: "" };

  return (
    <NodeViewWrapper
      className={`we-widget${props.selected ? " editing" : ""}`}
      data-wtype={wtype}
      contentEditable={false}
    >
      <span className="we-badge">{wtype}</span>
      {props.selected ? (
        <div className="we-form">
          <WidgetForm
            wtype={wtype}
            id={id}
            w={w}
            set={set}
            ctx={ctx}
            canGenerate={api?.canGenerate ?? false}
            busy={busy}
            runHeavy={runHeavy}
          />
        </div>
      ) : (
        <div className="we-body">
          <WidgetPreview id={id} wtype={wtype} w={w} />
        </div>
      )}
    </NodeViewWrapper>
  );
}

// A widget = one `::widget{type="…" id="…"}` marker line in the article. Renders
// as an atomic block; round-trips to the exact marker on save. Widget DATA lives
// in editor.storage.widget.widgets (loaded by the editor), keyed by id.
export const WidgetNode = Node.create({
  name: "widget",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      id: { default: "" },
      wtype: { default: "image" },
    };
  },

  addStorage() {
    return {
      widgets: {} as Record<string, AnyData>,
      markdown: {
        serialize(
          state: { write: (s: string) => void; closeBlock: (n: unknown) => void },
          node: { attrs: { id: string; wtype: string } }
        ) {
          state.write(`::widget{type="${node.attrs.wtype}" id="${node.attrs.id}"}`);
          state.closeBlock(node);
        },
        parse: {
          updateDOM(element: HTMLElement) {
            element.querySelectorAll("p").forEach((p) => {
              const m = (p.textContent || "").trim().match(/^::widget\{([^}]*)\}$/);
              if (!m) return;
              const div = element.ownerDocument.createElement("div");
              div.setAttribute("data-widget", "");
              div.setAttribute("data-wtype", parseParam(m[1], "type"));
              div.setAttribute("data-id", parseParam(m[1], "id"));
              p.replaceWith(div);
            });
          },
        },
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: "div[data-widget]",
        getAttrs: (el) => ({
          wtype: (el as HTMLElement).getAttribute("data-wtype") || "image",
          id: (el as HTMLElement).getAttribute("data-id") || "",
        }),
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-widget": "",
        "data-wtype": HTMLAttributes.wtype,
        "data-id": HTMLAttributes.id,
      }),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(WidgetBlockView);
  },
});

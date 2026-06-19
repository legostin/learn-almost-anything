import type { ReactNode } from "react";
import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer, NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { convertFileSrc } from "./transport";

// Widget types that exist in the article model (mirrors WidgetData in App.tsx).
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

type AnyWidget = Record<string, unknown> | undefined;

function resolveSrc(url: unknown): string {
  if (typeof url !== "string" || !url) return "";
  if (url.startsWith("http")) return url;
  return convertFileSrc(url);
}

// Read-only render of a widget block in the editor. Per-widget configuration
// (image search/upload, diagram/interactive fix, source field) is the next step.
function WidgetBlockView(props: ReactNodeViewProps) {
  const { id, wtype } = props.node.attrs as { id: string; wtype: string };
  const store = (
    props.editor.storage as unknown as { widget?: { widgets?: Record<string, AnyWidget> } }
  ).widget?.widgets;
  const w: AnyWidget = store?.[id];

  let body: ReactNode = null;
  if (wtype === "image") {
    const src = resolveSrc(w?.url);
    body = src ? (
      <img className="we-img" src={src} alt={(w?.alt as string) || ""} />
    ) : (
      <span className="we-muted">{(w?.description as string) || "Изображение"}</span>
    );
  } else if (wtype === "gallery") {
    const items = Array.isArray(w?.items) ? (w?.items as AnyWidget[]) : [];
    body = (
      <div className="we-gallery">
        {items.slice(0, 6).map((it, i) => {
          const src = resolveSrc(it?.url);
          return src ? <img key={i} src={src} alt="" /> : <span key={i} className="we-cell" />;
        })}
        {!items.length && <span className="we-muted">Галерея</span>}
      </div>
    );
  } else if (wtype === "diagram") {
    body = <pre className="we-code">{(w?.source as string) || "diagram"}</pre>;
  } else if (wtype === "video") {
    body = <span className="we-muted">▶ {(w?.title as string) || (w?.url as string) || "Видео"}</span>;
  } else if (wtype === "interactive") {
    body = <span className="we-muted">{(w?.title as string) || "Интерактив"}</span>;
  } else if (wtype === "checkpoint" || wtype === "recall") {
    body = <span className="we-muted">{(w?.question as string) || "Вопрос"}</span>;
  } else {
    body = <span className="we-muted">{wtype}</span>;
  }

  return (
    <NodeViewWrapper className="we-widget" data-wtype={wtype} contentEditable={false}>
      <span className="we-badge">{wtype}</span>
      <div className="we-body">{body}</div>
    </NodeViewWrapper>
  );
}

// A widget = one `::widget{type="…" id="…"}` marker line in the article. Renders
// as an atomic block; round-trips to the exact marker on save. Widget DATA lives
// in editor.storage.widget.widgets (set by the editor), keyed by id.
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
      widgets: {} as Record<string, AnyWidget>,
      markdown: {
        serialize(state: { write: (s: string) => void; closeBlock: (n: unknown) => void }, node: { attrs: { id: string; wtype: string } }) {
          state.write(`::widget{type="${node.attrs.wtype}" id="${node.attrs.id}"}`);
          state.closeBlock(node);
        },
        parse: {
          // tiptap-markdown renders markdown → HTML, then runs this on the HTML
          // before ProseMirror parses it. Turn each `::widget{…}` paragraph into
          // a widget element that parseHTML below picks up.
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

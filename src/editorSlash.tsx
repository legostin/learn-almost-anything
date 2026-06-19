import { Extension, type Editor, type Range } from "@tiptap/core";
import Suggestion from "@tiptap/suggestion";
import { ReactRenderer } from "@tiptap/react";
import { forwardRef, useEffect, useImperativeHandle, useState } from "react";

// One "/" command: a label + hint shown in the menu, keywords for filtering, and
// the editor mutation to run. Built (localized) by the editor and passed in via
// SlashCommands.configure({ commands }).
export type SlashCommand = {
  title: string;
  hint?: string;
  keywords?: string;
  run: (editor: Editor, range: Range) => void;
};

type MenuProps = {
  items: SlashCommand[];
  command: (item: SlashCommand) => void;
};

const SlashMenu = forwardRef<{ onKeyDown: (p: { event: KeyboardEvent }) => boolean }, MenuProps>(
  (props, ref) => {
    const [selected, setSelected] = useState(0);
    useEffect(() => setSelected(0), [props.items]);

    const pick = (i: number) => {
      const item = props.items[i];
      if (item) props.command(item);
    };

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }) => {
        if (!props.items.length) return false;
        if (event.key === "ArrowUp") {
          setSelected((s) => (s + props.items.length - 1) % props.items.length);
          return true;
        }
        if (event.key === "ArrowDown") {
          setSelected((s) => (s + 1) % props.items.length);
          return true;
        }
        if (event.key === "Enter") {
          pick(selected);
          return true;
        }
        return false;
      },
    }));

    if (!props.items.length) return <div className="slash-menu slash-empty">—</div>;
    return (
      <div className="slash-menu">
        {props.items.map((it, i) => (
          <button
            key={it.title}
            type="button"
            className={`slash-item${i === selected ? " active" : ""}`}
            onMouseEnter={() => setSelected(i)}
            onMouseDown={(e) => {
              e.preventDefault();
              pick(i);
            }}
          >
            <span className="slash-title">{it.title}</span>
            {it.hint && <span className="slash-hint">{it.hint}</span>}
          </button>
        ))}
      </div>
    );
  }
);
SlashMenu.displayName = "SlashMenu";

// Tiptap Suggestion render: mount the React menu in a fixed-positioned wrapper
// at the caret and forward key events to it.
function renderSlashMenu() {
  let component: ReactRenderer<{ onKeyDown: (p: { event: KeyboardEvent }) => boolean }, MenuProps> | null = null;
  let popup: HTMLDivElement | null = null;

  const place = (rect: (() => DOMRect | null) | null | undefined) => {
    if (!popup || !rect) return;
    const r = rect();
    if (!r) return;
    popup.style.left = `${Math.round(r.left)}px`;
    popup.style.top = `${Math.round(r.bottom + 6)}px`;
  };

  return {
    onStart: (props: { editor: Editor; clientRect?: (() => DOMRect | null) | null }) => {
      component = new ReactRenderer(SlashMenu, { props, editor: props.editor });
      popup = document.createElement("div");
      popup.className = "slash-popup";
      popup.style.position = "fixed";
      popup.style.zIndex = "1000";
      document.body.appendChild(popup);
      popup.appendChild(component.element);
      place(props.clientRect);
    },
    onUpdate: (props: { clientRect?: (() => DOMRect | null) | null }) => {
      component?.updateProps(props);
      place(props.clientRect);
    },
    onKeyDown: (props: { event: KeyboardEvent }) => {
      if (props.event.key === "Escape") {
        popup?.remove();
        return true;
      }
      return component?.ref?.onKeyDown(props) ?? false;
    },
    onExit: () => {
      popup?.remove();
      popup = null;
      component?.destroy();
      component = null;
    },
  };
}

export const SlashCommands = Extension.create<{ commands: SlashCommand[] }>({
  name: "slashCommands",
  addOptions() {
    return { commands: [] };
  },
  addProseMirrorPlugins() {
    const options = this.options;
    return [
      Suggestion<SlashCommand>({
        editor: this.editor,
        char: "/",
        allowSpaces: false,
        startOfLine: false,
        command: ({ editor, range, props }) => props.run(editor, range),
        items: ({ query }) => {
          const q = query.trim().toLowerCase();
          const list = options.commands;
          if (!q) return list.slice(0, 10);
          return list
            .filter(
              (c: SlashCommand) =>
                c.title.toLowerCase().includes(q) || (c.keywords ?? "").toLowerCase().includes(q)
            )
            .slice(0, 10);
        },
        render: renderSlashMenu,
      }),
    ];
  },
});

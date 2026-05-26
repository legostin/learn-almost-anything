import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

type Course = {
  id: string;
  topic: string;
  language: string;
  status: string;
  created_at: number;
  updated_at: number;
};

type View = { kind: "empty" } | { kind: "creating" } | { kind: "course"; id: string };

function App() {
  const [courses, setCourses] = useState<Course[]>([]);
  const [view, setView] = useState<View>({ kind: "empty" });

  async function refresh() {
    const list = await invoke<Course[]>("list_courses");
    setCourses(list);
  }

  useEffect(() => {
    refresh();
  }, []);

  return (
    <div className="app">
      <aside className="sidebar">
        <button className="new-course" onClick={() => setView({ kind: "creating" })}>
          + Новый курс
        </button>
        <ul className="course-list">
          {courses.map((c) => (
            <li
              key={c.id}
              className={view.kind === "course" && view.id === c.id ? "active" : ""}
              onClick={() => setView({ kind: "course", id: c.id })}
            >
              <div className="course-topic">{c.topic}</div>
              <div className="course-meta">
                {c.language} · {c.status}
              </div>
            </li>
          ))}
          {courses.length === 0 && <li className="empty-hint">Курсов пока нет</li>}
        </ul>
        <SmokeTest />
      </aside>

      <main className="main">
        {view.kind === "empty" && (
          <div className="placeholder">Выберите курс или создайте новый</div>
        )}
        {view.kind === "creating" && (
          <CreateCourse
            onCreated={async (id) => {
              await refresh();
              setView({ kind: "course", id });
            }}
            onCancel={() => setView({ kind: "empty" })}
          />
        )}
        {view.kind === "course" && (
          <CourseView course={courses.find((c) => c.id === view.id)} onChanged={refresh} />
        )}
      </main>
    </div>
  );
}

function CreateCourse({
  onCreated,
  onCancel,
}: {
  onCreated: (id: string) => void;
  onCancel: () => void;
}) {
  const [topic, setTopic] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!topic.trim() || busy) return;
    setBusy(true);
    const language = navigator.language.slice(0, 2) || "en";
    const id = await invoke<string>("create_course", { topic: topic.trim(), language });
    onCreated(id);
  }

  return (
    <form className="create-course" onSubmit={submit}>
      <h2>Новый курс</h2>
      <label>
        Тема
        <input
          autoFocus
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="например: академическая живопись"
        />
      </label>
      <div className="actions">
        <button type="submit" disabled={!topic.trim() || busy}>
          Создать
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          Отмена
        </button>
      </div>
    </form>
  );
}

function SmokeTest() {
  const [status, setStatus] = useState<string>("");
  const [busy, setBusy] = useState(false);

  async function ping() {
    setBusy(true);
    setStatus("…ping");
    try {
      const r = await invoke<{ pong: boolean; time: number }>("sidecar_call", {
        method: "ping",
        params: {},
      });
      setStatus(`ping ok (${r.time})`);
    } catch (e) {
      setStatus(`ping error: ${e}`);
    } finally {
      setBusy(false);
    }
  }

  async function claudeHello() {
    setBusy(true);
    setStatus("…спрашиваю Claude");
    try {
      const r = await invoke<{ text: string }>("sidecar_call", {
        method: "claude_chat",
        params: { prompt: "Say only the word PONG, nothing else." },
      });
      setStatus(`Claude: ${r.text}`);
    } catch (e) {
      setStatus(`claude error: ${e}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="smoke">
      <div className="smoke-row">
        <button onClick={ping} disabled={busy}>
          Ping sidecar
        </button>
        <button onClick={claudeHello} disabled={busy}>
          Test Claude
        </button>
      </div>
      {status && <div className="smoke-status">{status}</div>}
    </div>
  );
}

function CourseView({ course, onChanged }: { course?: Course; onChanged: () => void | Promise<void> }) {
  if (!course) return <div className="placeholder">Курс не найден</div>;
  return (
    <div className="course-view">
      <h2>{course.topic}</h2>
      <div className="course-meta-full">
        Язык: {course.language} · Статус: {course.status}
      </div>
      {course.status === "wizard" && <Wizard course={course} onSaved={onChanged} />}
      {course.status === "structuring" && (
        <div className="placeholder">Ответы сохранены. Генерация структуры — следующий этап (M3).</div>
      )}
      {course.status === "ready" && (
        <div className="placeholder">Структура готова. Здесь появится дерево модулей.</div>
      )}
    </div>
  );
}

type WizardState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "answering"; questions: string[]; answers: string[] }
  | { kind: "saving" }
  | { kind: "error"; message: string };

function Wizard({ course, onSaved }: { course: Course; onSaved: () => void | Promise<void> }) {
  const [state, setState] = useState<WizardState>({ kind: "idle" });

  async function startWizard() {
    setState({ kind: "loading" });
    try {
      const r = await invoke<{ questions: string[] }>("sidecar_call", {
        method: "wizard_questions",
        params: { topic: course.topic, language: course.language },
      });
      setState({
        kind: "answering",
        questions: r.questions,
        answers: r.questions.map(() => ""),
      });
    } catch (e) {
      setState({ kind: "error", message: String(e) });
    }
  }

  async function save() {
    if (state.kind !== "answering") return;
    const answers = state.questions.map((question, i) => ({
      question,
      answer: state.answers[i] ?? "",
    }));
    setState({ kind: "saving" });
    try {
      await invoke("save_wizard_answers", { courseId: course.id, answers });
      await onSaved();
    } catch (e) {
      setState({ kind: "error", message: String(e) });
    }
  }

  if (state.kind === "idle") {
    return (
      <div className="wizard">
        <p>
          Прежде чем строить программу, агент задаст несколько уточняющих вопросов.
          Это займёт ~10-30 секунд.
        </p>
        <button onClick={startWizard}>Начать визард</button>
      </div>
    );
  }
  if (state.kind === "loading") {
    return <div className="wizard"><p>Подумаю над вопросами…</p></div>;
  }
  if (state.kind === "saving") {
    return <div className="wizard"><p>Сохраняю ответы…</p></div>;
  }
  if (state.kind === "error") {
    return (
      <div className="wizard error">
        <p>Ошибка: {state.message}</p>
        <button onClick={() => setState({ kind: "idle" })}>Попробовать снова</button>
      </div>
    );
  }
  const canSave = state.answers.some((a) => a.trim().length > 0);
  return (
    <div className="wizard">
      <p>Ответь на вопросы — пропускай те, что не подходят.</p>
      <ol className="qna">
        {state.questions.map((q, i) => (
          <li key={i}>
            <div className="q">{q}</div>
            <textarea
              value={state.answers[i]}
              onChange={(e) => {
                const next = state.answers.slice();
                next[i] = e.target.value;
                setState({ ...state, answers: next });
              }}
              rows={3}
              placeholder="Твой ответ…"
            />
          </li>
        ))}
      </ol>
      <button onClick={save} disabled={!canSave}>
        Сохранить ответы
      </button>
    </div>
  );
}

export default App;

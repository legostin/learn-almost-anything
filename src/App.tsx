import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";

type Agent = "claude" | "codex";

type Course = {
  id: string;
  topic: string;
  language: string;
  status: string;
  agent: Agent;
  created_at: number;
  updated_at: number;
};

type Question = { text: string; options: string[] };

type ModuleNode = {
  id: string;
  title: string;
  summary: string;
  submodules: ModuleNode[];
};

type StructureFile = {
  course_id: string;
  modules: ModuleNode[];
};

type JobKind = "wizard_questions" | "build_structure";

type JobState =
  | { kind: JobKind; status: "running" }
  | { kind: JobKind; status: "done"; result?: unknown }
  | { kind: JobKind; status: "error"; error: string };

type JobEvent = {
  courseId: string;
  kind: JobKind;
  ok: boolean;
  result?: unknown;
  error?: string;
};

type View = { kind: "empty" } | { kind: "creating" } | { kind: "course"; id: string };

const jobKey = (courseId: string, kind: JobKind) => `${courseId}:${kind}`;

function App() {
  const [courses, setCourses] = useState<Course[]>([]);
  const [view, setView] = useState<View>({ kind: "empty" });
  const [jobs, setJobs] = useState<Map<string, JobState>>(new Map());

  const refresh = useCallback(async () => {
    const list = await invoke<Course[]>("list_courses");
    setCourses(list);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const unlistenP = listen<JobEvent>("agent_job", (e) => {
      const { courseId, kind, ok, result, error } = e.payload;
      setJobs((prev) => {
        const next = new Map(prev);
        next.set(
          jobKey(courseId, kind),
          ok
            ? { kind, status: "done", result }
            : { kind, status: "error", error: error ?? "unknown" }
        );
        return next;
      });
      // course.status may have flipped (e.g. build_structure → 'ready')
      refresh();
    });
    return () => {
      unlistenP.then((fn) => fn());
    };
  }, [refresh]);

  async function startJob(courseId: string, kind: JobKind) {
    setJobs((prev) => {
      const next = new Map(prev);
      next.set(jobKey(courseId, kind), { kind, status: "running" });
      return next;
    });
    try {
      await invoke(`start_${kind}`, { courseId });
    } catch (e) {
      setJobs((prev) => {
        const next = new Map(prev);
        next.set(jobKey(courseId, kind), { kind, status: "error", error: String(e) });
        return next;
      });
    }
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-dot" />
          Learn Anything
        </div>
        <button className="new-course" onClick={() => setView({ kind: "creating" })}>
          + Новый курс
        </button>
        <ul className="course-list">
          {courses.map((c) => {
            const hasRunning = ["wizard_questions", "build_structure"].some(
              (k) => jobs.get(jobKey(c.id, k as JobKind))?.status === "running"
            );
            return (
              <li
                key={c.id}
                className={view.kind === "course" && view.id === c.id ? "active" : ""}
                onClick={() => setView({ kind: "course", id: c.id })}
              >
                <div className="course-topic">
                  {c.topic}
                  {hasRunning && <span className="spinner" title="Идёт генерация…" />}
                </div>
                <div className="course-meta">
                  {c.language} · {c.status}
                </div>
              </li>
            );
          })}
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
          <CourseView
            course={courses.find((c) => c.id === view.id)}
            jobs={jobs}
            onStartJob={(kind) => startJob(view.id, kind)}
            onChanged={refresh}
          />
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
  const [agent, setAgent] = useState<Agent>("claude");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!topic.trim() || busy) return;
    setBusy(true);
    const language = navigator.language.slice(0, 2) || "en";
    const id = await invoke<string>("create_course", {
      topic: topic.trim(),
      language,
      agent,
    });
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
      <label>
        Агент
        <div className="agent-picker">
          <label className={`agent-option ${agent === "claude" ? "selected" : ""}`}>
            <input
              type="radio"
              name="agent"
              value="claude"
              checked={agent === "claude"}
              onChange={() => setAgent("claude")}
            />
            <div className="agent-meta">
              <div className="agent-name">Claude</div>
              <div className="agent-desc">Anthropic, подписка Pro/Max</div>
            </div>
          </label>
          <label className={`agent-option ${agent === "codex" ? "selected" : ""}`}>
            <input
              type="radio"
              name="agent"
              value="codex"
              checked={agent === "codex"}
              onChange={() => setAgent("codex")}
            />
            <div className="agent-meta">
              <div className="agent-name">Codex</div>
              <div className="agent-desc">OpenAI, ChatGPT-подписка, веб-поиск</div>
            </div>
          </label>
        </div>
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

function CourseView({
  course,
  jobs,
  onStartJob,
  onChanged,
}: {
  course?: Course;
  jobs: Map<string, JobState>;
  onStartJob: (kind: JobKind) => void;
  onChanged: () => void | Promise<void>;
}) {
  if (!course) return <div className="placeholder">Курс не найден</div>;
  const statusLabel: Record<string, string> = {
    wizard: "визард",
    structuring: "ждёт структуру",
    ready: "готов",
  };
  return (
    <div className="course-view">
      <h2>{course.topic}</h2>
      <div className="course-meta-full">
        <span className="lang-pill">{course.language}</span>
        <span className={`agent-pill agent-${course.agent}`}>{course.agent}</span>
        <span className={`status-pill status-${course.status}`}>
          {statusLabel[course.status] ?? course.status}
        </span>
      </div>
      {course.status === "wizard" && (
        <Wizard
          course={course}
          job={jobs.get(jobKey(course.id, "wizard_questions"))}
          onStart={() => onStartJob("wizard_questions")}
          onSaved={onChanged}
        />
      )}
      {course.status === "structuring" && (
        <StructureBuilder
          job={jobs.get(jobKey(course.id, "build_structure"))}
          onStart={() => onStartJob("build_structure")}
        />
      )}
      {course.status === "ready" && <Structure course={course} />}
    </div>
  );
}

function Wizard({
  course,
  job,
  onStart,
  onSaved,
}: {
  course: Course;
  job?: JobState;
  onStart: () => void;
  onSaved: () => void | Promise<void>;
}) {
  if (!job || (job.status === "done" && !job.result)) {
    return (
      <div className="wizard">
        <p>
          Прежде чем строить программу, агент задаст несколько уточняющих вопросов с вариантами
          ответов. Это займёт ~10-30 секунд — можно открыть другой курс или вернуться позже,
          UI не блокируется.
        </p>
        <button onClick={onStart}>Начать визард</button>
      </div>
    );
  }
  if (job.status === "running") {
    return (
      <div className="wizard">
        <p>Подумаю над вопросами…</p>
      </div>
    );
  }
  if (job.status === "error") {
    return (
      <div className="wizard error">
        <p>Ошибка: {job.error}</p>
        <button onClick={onStart}>Попробовать снова</button>
      </div>
    );
  }
  // status === "done"
  const result = job.result as { questions?: Question[] } | undefined;
  const questions = result?.questions ?? [];
  if (questions.length === 0) {
    return (
      <div className="wizard">
        <p>Агент не вернул вопросов.</p>
        <button onClick={onStart}>Попробовать снова</button>
      </div>
    );
  }
  return <AnsweringForm course={course} questions={questions} onSaved={onSaved} />;
}

type Answer = { selectedIndex: number | null; custom: string };

function AnsweringForm({
  course,
  questions,
  onSaved,
}: {
  course: Course;
  questions: Question[];
  onSaved: () => void | Promise<void>;
}) {
  const [answers, setAnswers] = useState<Answer[]>(
    questions.map(() => ({ selectedIndex: null, custom: "" }))
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function setAnswer(i: number, patch: Partial<Answer>) {
    setAnswers((prev) => prev.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  }

  function resolveAnswer(i: number): string {
    const a = answers[i];
    const custom = a.custom.trim();
    if (custom) return custom;
    if (a.selectedIndex !== null) return questions[i].options[a.selectedIndex] ?? "";
    return "";
  }

  const canSave = answers.some((_, i) => resolveAnswer(i).length > 0);

  async function save() {
    const pairs = questions.map((q, i) => ({
      question: q.text,
      answer: resolveAnswer(i),
    }));
    setSaving(true);
    setError(null);
    try {
      await invoke("save_wizard_answers", { courseId: course.id, answers: pairs });
      await onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="wizard">
      <p>Выбери вариант или впиши свой ответ. Пустые вопросы пропускаем.</p>
      <ol className="qna">
        {questions.map((q, i) => (
          <li key={i}>
            <div className="q">{q.text}</div>
            <div className="options">
              {q.options.map((opt, j) => (
                <label key={j} className="option">
                  <input
                    type="radio"
                    name={`q-${i}`}
                    checked={answers[i].selectedIndex === j && !answers[i].custom.trim()}
                    onChange={() => setAnswer(i, { selectedIndex: j, custom: "" })}
                  />
                  <span>{opt}</span>
                </label>
              ))}
            </div>
            <input
              className="custom-answer"
              type="text"
              value={answers[i].custom}
              placeholder="Свой ответ (если ни один не подходит)…"
              onChange={(e) => setAnswer(i, { custom: e.target.value })}
            />
          </li>
        ))}
      </ol>
      <button onClick={save} disabled={!canSave || saving}>
        {saving ? "Сохраняю…" : "Сохранить ответы"}
      </button>
      {error && <p style={{ color: "#c00" }}>Ошибка: {error}</p>}
    </div>
  );
}

function StructureBuilder({
  job,
  onStart,
}: {
  job?: JobState;
  onStart: () => void;
}) {
  const running = job?.status === "running";
  const errored = job?.status === "error";
  return (
    <div className="wizard">
      <p>
        Ответы визарда сохранены. Агент исследует тему и предложит структуру курса.
        Это займёт 30 секунд — 2 минуты. UI не блокируется — можно переключить курс.
      </p>
      <button onClick={onStart} disabled={running}>
        {running ? "Строю структуру…" : "Сгенерировать структуру"}
      </button>
      {errored && <p style={{ color: "#c00" }}>Ошибка: {(job as any).error}</p>}
    </div>
  );
}

function Structure({ course }: { course: Course }) {
  const [tree, setTree] = useState<StructureFile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setTree(null);
    setError(null);
    invoke<StructureFile>("get_structure", { courseId: course.id })
      .then((s) => !cancelled && setTree(s))
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [course.id]);

  if (error) return <div className="placeholder">Ошибка загрузки: {error}</div>;
  if (!tree) return <div className="placeholder">Загружаю структуру…</div>;
  if (tree.modules.length === 0)
    return <div className="placeholder">Структура пустая.</div>;

  return (
    <div className="structure">
      <StructureTree tree={tree} />
    </div>
  );
}

function StructureTree({ tree }: { tree: StructureFile }) {
  return (
    <ol className="modules">
      {tree.modules.map((m, i) => (
        <li key={m.id} className="module">
          <div className="module-title">
            <span className="num">{i + 1}.</span> {m.title}
          </div>
          {m.summary && <div className="module-summary">{m.summary}</div>}
          {m.submodules.length > 0 && (
            <ol className="submodules">
              {m.submodules.map((s, j) => (
                <li key={s.id} className="submodule">
                  <div className="submodule-title">
                    <span className="num">
                      {i + 1}.{j + 1}
                    </span>
                    {s.title}
                  </div>
                  {s.summary && <div className="submodule-summary">{s.summary}</div>}
                </li>
              ))}
            </ol>
          )}
        </li>
      ))}
    </ol>
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

export default App;

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";

type Course = {
  id: string;
  topic: string;
  language: string;
  status: string;
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
  const [draft, setDraft] = useState<StructureFile | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setTree(null);
    setDraft(null);
    setError(null);
    invoke<StructureFile>("get_structure", { courseId: course.id })
      .then((s) => !cancelled && setTree(s))
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [course.id]);

  async function save() {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const fresh = await invoke<StructureFile>("save_structure", {
        courseId: course.id,
        modules: draft.modules,
      });
      setTree(fresh);
      setDraft(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  if (error && !draft) return <div className="placeholder">Ошибка загрузки: {error}</div>;
  if (!tree) return <div className="placeholder">Загружаю структуру…</div>;

  if (draft) {
    return (
      <StructureEditor
        draft={draft}
        onChange={setDraft}
        onSave={save}
        onCancel={() => {
          setDraft(null);
          setError(null);
        }}
        saving={saving}
        error={error}
      />
    );
  }

  if (tree.modules.length === 0)
    return (
      <div className="structure">
        <div className="placeholder">Структура пустая.</div>
        <button className="ghost" onClick={() => setDraft(cloneTree(tree))}>
          Редактировать
        </button>
      </div>
    );

  return (
    <div className="structure">
      <div className="structure-toolbar">
        <button className="ghost" onClick={() => setDraft(cloneTree(tree))}>
          Редактировать
        </button>
      </div>
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
                      <span className="num">{i + 1}.{j + 1}</span>
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
    </div>
  );
}

function cloneTree(t: StructureFile): StructureFile {
  return {
    course_id: t.course_id,
    modules: t.modules.map((m) => ({
      id: m.id,
      title: m.title,
      summary: m.summary,
      submodules: m.submodules.map((s) => ({
        id: s.id,
        title: s.title,
        summary: s.summary,
        submodules: [],
      })),
    })),
  };
}

function emptyNode(): ModuleNode {
  return { id: "", title: "", summary: "", submodules: [] };
}

function StructureEditor({
  draft,
  onChange,
  onSave,
  onCancel,
  saving,
  error,
}: {
  draft: StructureFile;
  onChange: (d: StructureFile) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  error: string | null;
}) {
  function patchModule(i: number, patch: Partial<ModuleNode>) {
    onChange({
      ...draft,
      modules: draft.modules.map((m, idx) => (idx === i ? { ...m, ...patch } : m)),
    });
  }
  function patchSub(i: number, j: number, patch: Partial<ModuleNode>) {
    onChange({
      ...draft,
      modules: draft.modules.map((m, idx) =>
        idx === i
          ? {
              ...m,
              submodules: m.submodules.map((s, k) => (k === j ? { ...s, ...patch } : s)),
            }
          : m
      ),
    });
  }
  function moveModule(i: number, delta: number) {
    const j = i + delta;
    if (j < 0 || j >= draft.modules.length) return;
    const arr = draft.modules.slice();
    [arr[i], arr[j]] = [arr[j], arr[i]];
    onChange({ ...draft, modules: arr });
  }
  function moveSub(i: number, j: number, delta: number) {
    const m = draft.modules[i];
    const k = j + delta;
    if (k < 0 || k >= m.submodules.length) return;
    const arr = m.submodules.slice();
    [arr[j], arr[k]] = [arr[k], arr[j]];
    patchModule(i, { submodules: arr });
  }
  function removeModule(i: number) {
    onChange({ ...draft, modules: draft.modules.filter((_, idx) => idx !== i) });
  }
  function removeSub(i: number, j: number) {
    patchModule(i, { submodules: draft.modules[i].submodules.filter((_, k) => k !== j) });
  }
  function addModule() {
    onChange({ ...draft, modules: [...draft.modules, emptyNode()] });
  }
  function addSub(i: number) {
    patchModule(i, { submodules: [...draft.modules[i].submodules, emptyNode()] });
  }

  const hasEmpty =
    draft.modules.some((m) => !m.title.trim()) ||
    draft.modules.some((m) => m.submodules.some((s) => !s.title.trim()));

  return (
    <div className="structure editing">
      <div className="structure-toolbar">
        <button onClick={onSave} disabled={saving || hasEmpty}>
          {saving ? "Сохраняю…" : "Сохранить"}
        </button>
        <button className="ghost" onClick={onCancel} disabled={saving}>
          Отмена
        </button>
        {hasEmpty && <span className="hint warn">У некоторых модулей пустое название</span>}
      </div>
      {error && <p style={{ color: "var(--danger)" }}>Ошибка: {error}</p>}
      <ol className="modules">
        {draft.modules.map((m, i) => (
          <li key={i} className="module edit">
            <div className="row-actions">
              <span className="num">{i + 1}</span>
              <input
                className="edit-title"
                value={m.title}
                placeholder="Название модуля"
                onChange={(e) => patchModule(i, { title: e.target.value })}
              />
              <div className="row-buttons">
                <button className="icon" title="Вверх" onClick={() => moveModule(i, -1)}>
                  ↑
                </button>
                <button className="icon" title="Вниз" onClick={() => moveModule(i, 1)}>
                  ↓
                </button>
                <button
                  className="icon danger"
                  title="Удалить модуль"
                  onClick={() => removeModule(i)}
                >
                  ×
                </button>
              </div>
            </div>
            <textarea
              className="edit-summary"
              value={m.summary}
              placeholder="Краткое описание модуля…"
              rows={2}
              onChange={(e) => patchModule(i, { summary: e.target.value })}
            />
            <ol className="submodules">
              {m.submodules.map((s, j) => (
                <li key={j} className="submodule edit">
                  <div className="row-actions">
                    <span className="num">
                      {i + 1}.{j + 1}
                    </span>
                    <input
                      className="edit-title sub"
                      value={s.title}
                      placeholder="Название сабмодуля"
                      onChange={(e) => patchSub(i, j, { title: e.target.value })}
                    />
                    <div className="row-buttons">
                      <button className="icon" title="Вверх" onClick={() => moveSub(i, j, -1)}>
                        ↑
                      </button>
                      <button className="icon" title="Вниз" onClick={() => moveSub(i, j, 1)}>
                        ↓
                      </button>
                      <button
                        className="icon danger"
                        title="Удалить сабмодуль"
                        onClick={() => removeSub(i, j)}
                      >
                        ×
                      </button>
                    </div>
                  </div>
                  <textarea
                    className="edit-summary sub"
                    value={s.summary}
                    placeholder="Краткое описание сабмодуля…"
                    rows={1}
                    onChange={(e) => patchSub(i, j, { summary: e.target.value })}
                  />
                </li>
              ))}
            </ol>
            <button className="add-sub" onClick={() => addSub(i)}>
              + сабмодуль
            </button>
          </li>
        ))}
      </ol>
      <button className="add-mod" onClick={addModule}>
        + модуль
      </button>
    </div>
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

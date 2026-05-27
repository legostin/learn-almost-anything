import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useLang, useT } from "./i18n";
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

type GenState = "pending" | "generating" | "ready" | "failed";

type ModuleNode = {
  id: string;
  title: string;
  summary: string;
  generation_state: GenState;
  submodules: ModuleNode[];
};

type StructureFile = {
  course_id: string;
  modules: ModuleNode[];
};

type ChatRole = "user" | "agent" | "system";

type ChatMessage = {
  id: string;
  ts: number;
  role: ChatRole;
  text: string;
  modules: ModuleNode[];
};

type JobKind = "wizard_questions" | "build_structure" | "generate_submodule";

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

type View =
  | { kind: "empty" }
  | { kind: "creating" }
  | { kind: "course"; id: string }
  | { kind: "submodule"; courseId: string; moduleId: string; submoduleId: string };

type StageName = "draft" | "review" | "annotate";

type StageEvent = {
  courseId: string;
  submoduleId: string;
  stage: StageName;
};

const jobKey = (courseId: string, kind: JobKind) => `${courseId}:${kind}`;

function App() {
  const t = useT();
  const [courses, setCourses] = useState<Course[]>([]);
  const [view, setView] = useState<View>({ kind: "empty" });
  const [jobs, setJobs] = useState<Map<string, JobState>>(new Map());
  const [stages, setStages] = useState<Map<string, StageName>>(new Map());
  const [settingsOpen, setSettingsOpen] = useState(false);

  const refresh = useCallback(async () => {
    const list = await invoke<Course[]>("list_courses");
    setCourses(list);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const unlistenP = listen<JobEvent>("agent_job", async (e) => {
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
      // Goal hook: after an initial structure build, kick off the first
      // submodule generation so the learner has something to start with.
      // Do this BEFORE refresh so when Structure mounts the row is already
      // flipped to 'generating'.
      if (kind === "build_structure" && ok) {
        try {
          await invoke("start_first_pending_submodule", { courseId });
        } catch {
          /* swallowed; UI shows nothing extra */
        }
      }
      // course.status may have flipped (e.g. build_structure → 'ready')
      await refresh();
      // Terminal event for submodule generation — clear stage tracking.
      if (kind === "generate_submodule") {
        const subId = (e.payload as any).submoduleId as string | undefined;
        if (subId) {
          setStages((prev) => {
            if (!prev.has(subId)) return prev;
            const next = new Map(prev);
            next.delete(subId);
            return next;
          });
        }
      }
    });
    return () => {
      unlistenP.then((fn) => fn());
    };
  }, [refresh]);

  useEffect(() => {
    const unlistenP = listen<StageEvent>("agent_stage", (e) => {
      const { submoduleId, stage } = e.payload;
      setStages((prev) => {
        const next = new Map(prev);
        next.set(submoduleId, stage);
        return next;
      });
    });
    return () => {
      unlistenP.then((fn) => fn());
    };
  }, []);

  async function startSubmoduleGen(courseId: string, submoduleId: string) {
    try {
      await invoke("start_generate_submodule", { courseId, submoduleId });
    } catch (e) {
      console.error("start_generate_submodule failed", e);
    }
  }

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
          <span className="brand-name">{t("brand")}</span>
          <button
            className="brand-settings"
            onClick={() => setSettingsOpen(true)}
            title={t("settings")}
            aria-label={t("settings")}
          >
            <SettingsIcon />
          </button>
        </div>
        <button className="new-course" onClick={() => setView({ kind: "creating" })}>
          {t("newCourse")}
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
                  {hasRunning && <span className="spinner" title={t("generatingTitle")} />}
                </div>
                <div className="course-meta">
                  {c.language} · {c.status}
                </div>
              </li>
            );
          })}
          {courses.length === 0 && <li className="empty-hint">{t("noCourses")}</li>}
        </ul>
        <SmokeTest />
      </aside>

      <main className="main">
        {view.kind === "empty" && (
          <div className="placeholder">{t("selectOrCreate")}</div>
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
            onOpenSub={(moduleId, submoduleId) =>
              setView({ kind: "submodule", courseId: view.id, moduleId, submoduleId })
            }
            onStartSubGen={(submoduleId) => startSubmoduleGen(view.id, submoduleId)}
          />
        )}
        {view.kind === "submodule" && (
          <SubmoduleView
            course={courses.find((c) => c.id === view.courseId)}
            moduleId={view.moduleId}
            submoduleId={view.submoduleId}
            stage={stages.get(view.submoduleId) ?? null}
            onBack={() => setView({ kind: "course", id: view.courseId })}
            onStartGen={(subId) => startSubmoduleGen(view.courseId, subId)}
          />
        )}
      </main>

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

function SettingsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function SettingsModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [lang, setLang] = useLang();
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <h2>{t("settingsTitle")}</h2>
        <div className="setting-group">
          <div className="setting-label">{t("uiLanguage")}</div>
          <div className="lang-picker">
            <button
              className={`lang-option ${lang === "ru" ? "active" : ""}`}
              onClick={() => setLang("ru")}
            >
              {t("langRu")}
            </button>
            <button
              className={`lang-option ${lang === "en" ? "active" : ""}`}
              onClick={() => setLang("en")}
            >
              {t("langEn")}
            </button>
          </div>
          <div className="setting-note">{t("uiLanguageNote")}</div>
        </div>
        <div className="modal-actions">
          <button onClick={onClose}>{t("close")}</button>
        </div>
      </div>
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
  const t = useT();
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
      <h2>{t("createTitle")}</h2>
      <label>
        {t("topicLabel")}
        <input
          autoFocus
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder={t("topicPlaceholder")}
        />
      </label>
      <label>
        {t("agentLabel")}
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
              <div className="agent-desc">{t("claudeDesc")}</div>
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
              <div className="agent-desc">{t("codexDesc")}</div>
            </div>
          </label>
        </div>
      </label>
      <div className="actions">
        <button type="submit" disabled={!topic.trim() || busy}>
          {t("create")}
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          {t("cancel")}
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
  onOpenSub,
  onStartSubGen,
}: {
  course?: Course;
  jobs: Map<string, JobState>;
  onStartJob: (kind: JobKind) => void;
  onChanged: () => void | Promise<void>;
  onOpenSub: (moduleId: string, submoduleId: string) => void;
  onStartSubGen: (submoduleId: string) => void | Promise<void>;
}) {
  const t = useT();
  if (!course) return <div className="placeholder">{t("courseNotFound")}</div>;
  const statusLabel: Record<string, string> = {
    wizard: t("statusWizard"),
    structuring: t("statusStructuring"),
    ready: t("statusReady"),
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
      {course.status === "ready" && (
        <Structure
          course={course}
          onOpenSub={onOpenSub}
          onStartSubGen={onStartSubGen}
        />
      )}
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
  const t = useT();
  if (!job || (job.status === "done" && !job.result)) {
    return (
      <div className="wizard">
        <p>{t("wizardIntro")}</p>
        <button onClick={onStart}>{t("startWizard")}</button>
      </div>
    );
  }
  if (job.status === "running") {
    return (
      <div className="wizard">
        <p>{t("wizardThinking")}</p>
      </div>
    );
  }
  if (job.status === "error") {
    return (
      <div className="wizard error">
        <p>{t("errorPrefix", { error: job.error })}</p>
        <button onClick={onStart}>{t("retry")}</button>
      </div>
    );
  }
  // status === "done"
  const result = job.result as { questions?: Question[] } | undefined;
  const questions = result?.questions ?? [];
  if (questions.length === 0) {
    return (
      <div className="wizard">
        <p>{t("noQuestionsReturned")}</p>
        <button onClick={onStart}>{t("retry")}</button>
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
  const t = useT();
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
      <p>{t("answeringIntro")}</p>
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
              placeholder={t("customAnswerPlaceholder")}
              onChange={(e) => setAnswer(i, { custom: e.target.value })}
            />
          </li>
        ))}
      </ol>
      <button onClick={save} disabled={!canSave || saving}>
        {saving ? t("saving") : t("saveAnswers")}
      </button>
      {error && <p style={{ color: "var(--danger)" }}>{t("errorPrefix", { error })}</p>}
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
  const t = useT();
  const running = job?.status === "running";
  const errored = job?.status === "error";
  return (
    <div className="wizard">
      <p>{t("builderIntro")}</p>
      <button onClick={onStart} disabled={running}>
        {running ? t("buildingStructure") : t("generateStructure")}
      </button>
      {errored && (
        <p style={{ color: "var(--danger)" }}>
          {t("errorPrefix", { error: (job as any).error })}
        </p>
      )}
    </div>
  );
}

function Structure({
  course,
  onOpenSub,
  onStartSubGen,
}: {
  course: Course;
  onOpenSub: (moduleId: string, submoduleId: string) => void;
  onStartSubGen: (submoduleId: string) => void | Promise<void>;
}) {
  const t = useT();
  const [tree, setTree] = useState<StructureFile | null>(null);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [accepting, setAccepting] = useState<string | null>(null);
  const [showRefine, setShowRefine] = useState(false);
  // Avoid re-triggering on every tree update when nothing has been generated.
  const autoTriggeredFor = useRef<string | null>(null);

  async function reloadChat() {
    try {
      const msgs = await invoke<ChatMessage[]>("list_chat", { courseId: course.id });
      setChat(msgs);
    } catch (e) {
      setError(String(e));
    }
  }

  async function reloadTree() {
    try {
      const t = await invoke<StructureFile>("get_structure", { courseId: course.id });
      setTree(t);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    let cancelled = false;
    setTree(null);
    setChat([]);
    setError(null);
    setInput("");
    setShowRefine(false);
    Promise.all([
      invoke<StructureFile>("get_structure", { courseId: course.id }),
      invoke<ChatMessage[]>("list_chat", { courseId: course.id }),
    ])
      .then(([t, c]) => {
        if (cancelled) return;
        setTree(t);
        setChat(c);
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [course.id]);

  useEffect(() => {
    const unl = listen<JobEvent>("agent_job", async (e) => {
      const p = e.payload as any;
      if (p.courseId !== course.id) return;
      if (p.kind === "refine_structure") {
        await reloadChat();
      } else if (p.kind === "generate_submodule") {
        // Submodule generation finished (ok or failed) — pull fresh state.
        await reloadTree();
      }
    });
    return () => {
      unl.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [course.id]);

  const isAgentThinking = chat.length > 0 && chat[chat.length - 1].role === "user";

  async function send() {
    const text = input.trim();
    if (!text || isAgentThinking) return;
    setInput("");
    try {
      await invoke("start_structure_refine", { courseId: course.id, userMessage: text });
      await reloadChat();
    } catch (e) {
      setError(String(e));
    }
  }

  async function kickFirstPending() {
    try {
      const sid = await invoke<string | null>("start_first_pending_submodule", {
        courseId: course.id,
      });
      if (sid) await reloadTree();
    } catch (e) {
      setError(String(e));
    }
  }

  // Auto-kick on first entry to a 'ready' course where nothing has been
  // generated yet — covers the case where the build_structure → first-sub
  // auto-trigger missed (initial wizard happened on an older build).
  useEffect(() => {
    if (!tree) return;
    if (autoTriggeredFor.current === course.id) return;
    const allSubs = tree.modules.flatMap((m) => m.submodules);
    if (allSubs.length === 0) return;
    const hasActivity = allSubs.some(
      (s) => s.generation_state === "generating" || s.generation_state === "ready"
    );
    const hasPending = allSubs.some((s) => s.generation_state === "pending");
    if (hasActivity || !hasPending) return;
    autoTriggeredFor.current = course.id;
    kickFirstPending();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree, course.id]);

  async function accept(messageId: string) {
    setAccepting(messageId);
    try {
      const fresh = await invoke<StructureFile>("accept_structure_refinement", {
        courseId: course.id,
        messageId,
      });
      setTree(fresh);
      await reloadChat();
      // Collapse the refine dialog — user wanted a clean view of the
      // accepted plan, not the history of how we got here.
      setShowRefine(false);
      autoTriggeredFor.current = null; // allow auto-kick for the new tree
      // Goal hook: after the user accepts a refined plan, kick off the
      // first submodule generation automatically.
      invoke("start_first_pending_submodule", { courseId: course.id })
        .then(() => reloadTree())
        .catch(() => {});
    } catch (e) {
      setError(String(e));
    } finally {
      setAccepting(null);
    }
  }

  if (error && !tree) return <div className="placeholder">{t("loadError", { error })}</div>;
  if (!tree) return <div className="placeholder">{t("loadingStructure")}</div>;

  return (
    <div className="structure">
      {tree.modules.length === 0 ? (
        <div className="placeholder">{t("emptyStructure")}</div>
      ) : (
        <>
          <div className="structure-toolbar">
            <button
              className="ghost"
              onClick={() => setShowRefine((v) => !v)}
              aria-expanded={showRefine}
            >
              {showRefine ? t("closeRefine") : t("refinePlanButton")}
            </button>
          </div>
          <StructureTree
            tree={tree}
            onOpenSub={onOpenSub}
            onStartSubGen={(subId) => {
              const mod = tree.modules.find((m) =>
                m.submodules.some((s) => s.id === subId)
              );
              if (!mod) return;
              onStartSubGen(subId);
              onOpenSub(mod.id, subId);
            }}
          />
        </>
      )}

      {showRefine && (
        <RefineChat
          course={course}
          chat={chat}
          input={input}
          onInputChange={setInput}
          onSend={send}
          onAccept={accept}
          thinking={isAgentThinking}
          accepting={accepting}
        />
      )}
      {error && tree && <p className="error-banner">{t("errorPrefix", { error })}</p>}
    </div>
  );
}

function RefineChat({
  course,
  chat,
  input,
  onInputChange,
  onSend,
  onAccept,
  thinking,
  accepting,
}: {
  course: Course;
  chat: ChatMessage[];
  input: string;
  onInputChange: (s: string) => void;
  onSend: () => void;
  onAccept: (id: string) => void;
  thinking: boolean;
  accepting: string | null;
}) {
  const t = useT();
  const lastIdx = chat.length - 1;
  const placeholder =
    chat.length === 0 ? t("refineInputPlaceholder") : t("refineInputPlaceholderShort");

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSend();
    }
  }

  return (
    <section className="refine">
      <header className="refine-header">
        <div className="refine-title">{t("refineTitle")}</div>
        <div className="refine-sub">{t("refineSub")}</div>
      </header>

      <div className="refine-history">
        {chat.length === 0 && !thinking && (
          <div className="chat-empty">{t("chatEmpty")}</div>
        )}
        {chat.map((msg, idx) => {
          const isLast = idx === lastIdx;
          const hasProposal = msg.role === "agent" && msg.modules.length > 0;
          const isPending = hasProposal && isLast && accepting !== msg.id;
          const isAccepting = accepting === msg.id;
          if (msg.role === "system") {
            return (
              <div key={msg.id} className="chat-system">
                {msg.text}
              </div>
            );
          }
          return (
            <div key={msg.id} className={`chat-msg msg-${msg.role}`}>
              <div className="bubble">{msg.text}</div>
              {hasProposal && (
                <div className="proposal">
                  <div className="proposal-header">{t("proposal")}</div>
                  <StructureTree
                    tree={{ course_id: course.id, modules: msg.modules }}
                  />
                  {isPending && (
                    <div className="proposal-actions">
                      <button onClick={() => onAccept(msg.id)}>{t("accept")}</button>
                      <span className="proposal-hint">{t("proposalHint")}</span>
                    </div>
                  )}
                  {isAccepting && <span className="proposal-hint">{t("applying")}</span>}
                </div>
              )}
            </div>
          );
        })}
        {thinking && (
          <div className="chat-msg msg-agent">
            <div className="bubble thinking">
              <span className="spinner" /> {t("agentThinking")}
            </div>
          </div>
        )}
      </div>

      <div className="refine-input">
        <textarea
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={onKeyDown}
          rows={3}
          placeholder={placeholder}
          disabled={thinking}
        />
        <div className="refine-input-row">
          <span className="kbd-hint">{t("kbdHint")}</span>
          <button onClick={onSend} disabled={!input.trim() || thinking}>
            {t("send")}
          </button>
        </div>
      </div>
    </section>
  );
}

function StructureTree({
  tree,
  onOpenSub,
  onStartSubGen,
}: {
  tree: StructureFile;
  onOpenSub?: (moduleId: string, submoduleId: string) => void;
  onStartSubGen?: (submoduleId: string) => void;
}) {
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
                <li key={s.id} className={`submodule state-${s.generation_state}`}>
                  <div className="submodule-row">
                    <div
                      className="submodule-title"
                      onClick={() => onOpenSub?.(m.id, s.id)}
                      role={onOpenSub ? "button" : undefined}
                    >
                      <span className="num">
                        {i + 1}.{j + 1}
                      </span>
                      {s.title}
                      <SubmoduleStateIcon state={s.generation_state} />
                    </div>
                    {onOpenSub && onStartSubGen && (
                      <SubmoduleAction
                        state={s.generation_state}
                        onOpen={() => onOpenSub(m.id, s.id)}
                        onGenerate={() => onStartSubGen(s.id)}
                      />
                    )}
                  </div>
                  {s.summary && (
                    <div
                      className="submodule-summary"
                      onClick={() => onOpenSub?.(m.id, s.id)}
                    >
                      {s.summary}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          )}
        </li>
      ))}
    </ol>
  );
}

function SubmoduleAction({
  state,
  onOpen,
  onGenerate,
}: {
  state: GenState;
  onOpen: () => void;
  onGenerate: () => void;
}) {
  const t = useT();
  if (state === "ready") {
    return (
      <button
        className="sub-action open"
        onClick={(e) => {
          e.stopPropagation();
          onOpen();
        }}
      >
        {t("subOpen")}
      </button>
    );
  }
  if (state === "generating") {
    return (
      <button
        className="sub-action busy"
        onClick={(e) => {
          e.stopPropagation();
          onOpen();
        }}
      >
        <span className="spinner" />
      </button>
    );
  }
  if (state === "failed") {
    return (
      <button
        className="sub-action retry"
        onClick={(e) => {
          e.stopPropagation();
          onGenerate();
        }}
      >
        {t("subRetry")}
      </button>
    );
  }
  // pending
  return (
    <button
      className="sub-action gen"
      onClick={(e) => {
        e.stopPropagation();
        onGenerate();
      }}
    >
      {t("subGenerate")}
    </button>
  );
}

type SubmoduleContent = {
  article: string;
  widgets: Record<string, WidgetData>;
  review_notes: string;
};

type WidgetData = {
  type: string;
  placeholder?: boolean;
  description?: string;
  alt?: string;
};

function SubmoduleView({
  course,
  moduleId,
  submoduleId,
  stage,
  onBack,
  onStartGen,
}: {
  course?: Course;
  moduleId: string;
  submoduleId: string;
  stage: StageName | null;
  onBack: () => void;
  onStartGen: (submoduleId: string) => void | Promise<void>;
}) {
  const t = useT();
  const [tree, setTree] = useState<StructureFile | null>(null);
  const [content, setContent] = useState<SubmoduleContent | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reloadTree = useCallback(async () => {
    if (!course) return;
    try {
      const s = await invoke<StructureFile>("get_structure", { courseId: course.id });
      setTree(s);
    } catch (e) {
      setError(String(e));
    }
  }, [course]);

  const reloadContent = useCallback(async () => {
    if (!course) return;
    try {
      const c = await invoke<SubmoduleContent>("read_submodule_article", {
        courseId: course.id,
        moduleId,
        submoduleId,
      });
      setContent(c);
    } catch (e) {
      // article.md not yet on disk — leave content null
      setContent(null);
    }
  }, [course, moduleId, submoduleId]);

  useEffect(() => {
    setContent(null);
    setError(null);
    reloadTree();
  }, [reloadTree, submoduleId]);

  const sub = tree?.modules
    .find((m) => m.id === moduleId)
    ?.submodules.find((s) => s.id === submoduleId);
  const state = sub?.generation_state ?? "pending";

  useEffect(() => {
    if (state === "ready") reloadContent();
  }, [state, reloadContent]);

  useEffect(() => {
    if (!course) return;
    const unl = listen<JobEvent>("agent_job", async (e) => {
      const p = e.payload as any;
      if (p.courseId !== course.id) return;
      if (p.kind !== "generate_submodule") return;
      if (p.submoduleId && p.submoduleId !== submoduleId) return;
      await reloadTree();
    });
    return () => {
      unl.then((f) => f());
    };
  }, [course, submoduleId, reloadTree]);

  if (!course) return <div className="placeholder">{t("courseNotFound")}</div>;
  if (!sub && !tree) return <div className="placeholder">{t("loadingStructure")}</div>;
  if (!sub) return <div className="placeholder">{t("courseNotFound")}</div>;

  const moduleIdx = tree!.modules.findIndex((m) => m.id === moduleId);
  const subIdx =
    tree!.modules[moduleIdx]?.submodules.findIndex((s) => s.id === submoduleId) ?? 0;

  return (
    <div className="submodule-view">
      <button className="sub-back" onClick={onBack}>
        {t("backToCourse")}
      </button>
      <div className="sub-numbering">
        {moduleIdx + 1}.{subIdx + 1}
      </div>
      <h1 className="sub-h1">{sub.title}</h1>
      {sub.summary && <div className="sub-lead">{sub.summary}</div>}

      {(state === "pending" || state === "failed") && (
        <div className="sub-empty">
          <p>
            {state === "failed" ? t("stageFailedHint") : t("stagePendingHint")}
          </p>
          <button onClick={() => onStartGen(submoduleId)}>
            {state === "failed" ? t("subRetry") : t("subGenerate")}
          </button>
          {error && <p className="error-banner">{t("errorPrefix", { error })}</p>}
        </div>
      )}

      {state === "generating" && (
        <div className="sub-generating">
          <StageStrip current={stage ?? "draft"} />
          <div className="sub-generating-label">
            <span className="spinner" /> {t("stageRunning")}
          </div>
        </div>
      )}

      {state === "ready" && (
        <>
          {!content && <div className="placeholder">{t("loadingStructure")}</div>}
          {content && (
            <ArticleReader article={content.article} widgets={content.widgets} />
          )}
        </>
      )}
    </div>
  );
}

const STAGE_ORDER: StageName[] = ["draft", "review", "annotate"];

function StageStrip({ current }: { current: StageName }) {
  const t = useT();
  const idx = STAGE_ORDER.indexOf(current);
  const labels: Record<StageName, string> = {
    draft: t("stageDraft"),
    review: t("stageReview"),
    annotate: t("stageAnnotate"),
  };
  return (
    <ol className="stage-strip">
      {STAGE_ORDER.map((s, i) => {
        const isDone = i < idx;
        const isActive = i === idx;
        return (
          <li
            key={s}
            className={`stage ${isDone ? "done" : ""} ${isActive ? "active" : ""}`}
          >
            <span className="stage-dot">{isDone ? "✓" : i + 1}</span>
            <span className="stage-label">{labels[s]}</span>
          </li>
        );
      })}
    </ol>
  );
}

function ArticleReader({
  article,
  widgets,
}: {
  article: string;
  widgets: Record<string, WidgetData>;
}) {
  const parts = splitWidgetMarkers(article);
  return (
    <article className="reader">
      {parts.map((p, i) =>
        p.kind === "md" ? (
          <ReactMarkdown key={i}>{p.text}</ReactMarkdown>
        ) : (
          <WidgetPlaceholder key={i} id={p.id} widget={widgets[p.id]} />
        )
      )}
    </article>
  );
}

function splitWidgetMarkers(md: string) {
  const out: Array<{ kind: "md"; text: string } | { kind: "widget"; id: string }> = [];
  const re = /^::widget\{([^}]+)\}$/gm;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md))) {
    if (m.index > last) out.push({ kind: "md", text: md.slice(last, m.index) });
    const id = /id="([^"]+)"/.exec(m[1])?.[1] ?? "unknown";
    out.push({ kind: "widget", id });
    last = m.index + m[0].length;
  }
  if (last < md.length) out.push({ kind: "md", text: md.slice(last) });
  return out;
}

function WidgetPlaceholder({ id, widget }: { id: string; widget?: WidgetData }) {
  const t = useT();
  return (
    <figure className="widget widget-image">
      <div className="widget-image-box">
        <span className="widget-label">{t("widgetImage")}</span>
        <span className="widget-id">#{id}</span>
      </div>
      {widget?.description && (
        <figcaption>
          {widget.description}
          {widget.alt && (
            <span className="widget-alt">
              {" "}
              · {t("widgetImageAlt")} {widget.alt}
            </span>
          )}
        </figcaption>
      )}
    </figure>
  );
}

function SubmoduleStateIcon({ state }: { state: GenState }) {
  const t = useT();
  if (state === "generating") {
    return <span className="state-icon generating" title={t("generatingTitle")} />;
  }
  if (state === "ready") {
    return (
      <span className="state-icon ready" title="ready" aria-label="ready">
        ✓
      </span>
    );
  }
  if (state === "failed") {
    return (
      <span className="state-icon failed" title="failed" aria-label="failed">
        !
      </span>
    );
  }
  return null;
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

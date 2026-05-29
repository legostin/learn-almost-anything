import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import QRCode from "qrcode";
import { convertFileSrc, invoke, listen, isTauri } from "./transport";
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

type Question = { text: string; options: string[]; multi?: boolean };

type GenState = "pending" | "generating" | "ready" | "failed";

type ModuleNode = {
  id: string;
  title: string;
  summary: string;
  generation_state: GenState;
  test_passed?: boolean;
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

type StageName = "draft" | "annotate" | "illustrate" | "test";

type TestQuestion = {
  text: string;
  options: string[];
  correct: number;
  explanation: string;
};

type StageEvent = {
  courseId: string;
  submoduleId: string;
  stage: StageName;
  label?: string;
  detail?: string;
};

type StageDetail = { stage: StageName; label?: string; detail?: string };

// One entry in the live agent transcript shown during generation.
type Bubble = { kind: string; text: string; stage?: string };

type StageModel = { model: string | null; reasoning: string | null };
type BackendModels = { planning: StageModel; writing: StageModel; tests: StageModel };
type ModelConfig = { claude: BackendModels; codex: BackendModels };
type ModelBackend = "claude" | "codex";
type ModelCategory = "planning" | "writing" | "tests";
type ModelInfoLite = {
  value: string;
  label: string;
  description?: string;
  effortLevels: string[];
};

const jobKey = (courseId: string, kind: JobKind) => `${courseId}:${kind}`;

function App() {
  const t = useT();
  const [courses, setCourses] = useState<Course[]>([]);
  const [view, setView] = useState<View>({ kind: "empty" });
  const [jobs, setJobs] = useState<Map<string, JobState>>(new Map());
  const [stages, setStages] = useState<Map<string, StageDetail>>(new Map());
  const [transcripts, setTranscripts] = useState<Map<string, Bubble[]>>(new Map());
  const [subErrors, setSubErrors] = useState<Map<string, string>>(new Map());
  // Submodules that are readable but still backfilling images + test.
  const [enrichingSubs, setEnrichingSubs] = useState<Set<string>>(new Set());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [agentAvail, setAgentAvail] = useState<{ claude: boolean; codex: boolean } | null>(
    null
  );
  const [braveConfigured, setBraveConfigured] = useState<boolean | null>(null);

  const refreshCapabilities = useCallback(async () => {
    try {
      const [aa, ss] = await Promise.all([
        invoke<{ claude: boolean; codex: boolean }>("check_agent_availability"),
        invoke<{ brave_configured: boolean }>("get_settings_status"),
      ]);
      setAgentAvail(aa);
      setBraveConfigured(ss.brave_configured);
    } catch (e) {
      console.error(e);
    }
  }, []);

  useEffect(() => {
    refreshCapabilities();
  }, [refreshCapabilities]);

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
      // Terminal event for submodule generation — clear stage tracking
      // and record (or clear) the error for that sub.
      if (kind === "generate_submodule") {
        const subId = (e.payload as any).submoduleId as string | undefined;
        const enriching = !!(e.payload as any).enriching;
        if (subId) {
          setStages((prev) => {
            if (!prev.has(subId)) return prev;
            const next = new Map(prev);
            next.delete(subId);
            return next;
          });
          setSubErrors((prev) => {
            const next = new Map(prev);
            if (ok) next.delete(subId);
            else next.set(subId, error ?? "unknown");
            return next;
          });
          // The article is ready; images + test still backfill in the
          // background (an 'agent_enrich' event clears this).
          setEnrichingSubs((prev) => {
            const next = new Set(prev);
            if (ok && enriching) next.add(subId);
            else next.delete(subId);
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
      const { submoduleId, stage, label, detail } = e.payload;
      setStages((prev) => {
        const next = new Map(prev);
        const prevDetail = prev.get(submoduleId);
        // Stage-only event (no label) resets sub-state. Progress event keeps stage,
        // updates label/detail.
        if (!label) {
          next.set(submoduleId, { stage });
        } else {
          next.set(submoduleId, {
            stage: stage ?? prevDetail?.stage ?? "draft",
            label,
            detail,
          });
        }
        return next;
      });
      // Build the live transcript of agent bubbles.
      setTranscripts((prev) => {
        const next = new Map(prev);
        const cur = next.get(submoduleId) ?? [];
        if (!label) {
          // Stage transition. A fresh "draft" stage starts a new run.
          if (stage === "draft" && cur.length > 0) {
            next.set(submoduleId, [{ kind: "stage", text: stage, stage }]);
          } else {
            next.set(submoduleId, [...cur, { kind: "stage", text: stage, stage }]);
          }
        } else {
          const text = detail ?? "";
          const last = cur[cur.length - 1];
          // Coalesce consecutive same-kind streaming updates into one bubble.
          if (last && last.kind === label && last.kind !== "stage") {
            next.set(submoduleId, [...cur.slice(0, -1), { kind: label, text, stage }]);
          } else {
            next.set(submoduleId, [...cur, { kind: label, text, stage }]);
          }
        }
        return next;
      });
    });
    return () => {
      unlistenP.then((fn) => fn());
    };
  }, []);

  // Background enrichment finished for a submodule — it's no longer "loading
  // images + test". The open reader reloads its own content separately.
  useEffect(() => {
    const unlistenP = listen<{ courseId: string; submoduleId: string }>(
      "agent_enrich",
      (e) => {
        const { submoduleId } = e.payload;
        setEnrichingSubs((prev) => {
          if (!prev.has(submoduleId)) return prev;
          const next = new Set(prev);
          next.delete(submoduleId);
          return next;
        });
      }
    );
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
    // Structure-phase transcript is keyed by courseId — reset it on a new run.
    if (kind === "build_structure" || kind === "wizard_questions") {
      setTranscripts((prev) => {
        const next = new Map(prev);
        next.delete(courseId);
        return next;
      });
    }
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

  const menuHidden = view.kind !== "empty";
  return (
    <AudioPlayerProvider>
    <div className={`app${menuHidden ? " menu-hidden" : ""}`}>
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
      </aside>

      <main className="main">
        <div className="main-inner">
        <CapabilityBanners
          agentAvail={agentAvail}
          braveConfigured={braveConfigured}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        {(view.kind === "course" || view.kind === "submodule") && (
          <nav className="crumbs">
            <button className="crumb" onClick={() => setView({ kind: "empty" })}>
              {t("crumbCourses")}
            </button>
            {view.kind === "submodule" && (
              <>
                <span className="crumb-sep">›</span>
                <button
                  className="crumb"
                  onClick={() => setView({ kind: "course", id: view.courseId })}
                >
                  {courses.find((c) => c.id === view.courseId)?.topic ?? "…"}
                </button>
              </>
            )}
          </nav>
        )}
        {view.kind === "empty" && (
          <div className="placeholder">{t("selectOrCreate")}</div>
        )}
        {view.kind === "creating" && (
          <CreateCourse
            agentAvail={agentAvail}
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
            structureTranscript={transcripts.get(view.id) ?? null}
            onStartJob={(kind) => startJob(view.id, kind)}
            onChanged={refresh}
            onOpenSub={(moduleId, submoduleId) =>
              setView({ kind: "submodule", courseId: view.id, moduleId, submoduleId })
            }
            onStartSubGen={(submoduleId) => startSubmoduleGen(view.id, submoduleId)}
            onDeleted={async () => {
              setView({ kind: "empty" });
              await refresh();
            }}
          />
        )}
        {view.kind === "submodule" && (
          <SubmoduleView
            course={courses.find((c) => c.id === view.courseId)}
            moduleId={view.moduleId}
            submoduleId={view.submoduleId}
            stageDetail={stages.get(view.submoduleId) ?? null}
            transcript={transcripts.get(view.submoduleId) ?? null}
            lastError={subErrors.get(view.submoduleId) ?? null}
            enriching={enrichingSubs.has(view.submoduleId)}
            onStartGen={(subId) => startSubmoduleGen(view.courseId, subId)}
          />
        )}
        </div>
      </main>

      {settingsOpen && (
        <SettingsModal
          onClose={() => {
            setSettingsOpen(false);
            refreshCapabilities();
          }}
        />
      )}
    </div>
    </AudioPlayerProvider>
  );
}

function CapabilityBanners({
  agentAvail,
  braveConfigured,
  onOpenSettings,
}: {
  agentAvail: { claude: boolean; codex: boolean } | null;
  braveConfigured: boolean | null;
  onOpenSettings: () => void;
}) {
  const t = useT();
  if (!agentAvail) return null; // still loading
  const noAgents = !agentAvail.claude && !agentAvail.codex;
  if (noAgents) {
    return (
      <div className="banner banner-error" role="alert">
        <div className="banner-title">{t("noAgentsTitle")}</div>
        <div className="banner-body">{t("noAgentsBody")}</div>
      </div>
    );
  }
  if (braveConfigured === false) {
    return (
      <div className="banner banner-warn">
        <div className="banner-body">{t("braveMissingWarning")}</div>
        <button className="banner-action" onClick={onOpenSettings}>
          {t("openSettings")}
        </button>
      </div>
    );
  }
  return null;
}

function SettingsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

// Selectable Gemini models for image generation and TTS.
const GEMINI_IMAGE_MODELS: { id: string; ru: string; en: string }[] = [
  { id: "gemini-2.5-flash-image", ru: "Flash (быстрее, дешевле)", en: "Flash (faster, cheaper)" },
  { id: "gemini-2.5-flash-image-preview", ru: "Flash Preview", en: "Flash Preview" },
];
const GEMINI_TTS_MODELS: { id: string; ru: string; en: string }[] = [
  { id: "gemini-2.5-flash-preview-tts", ru: "Flash TTS (дешевле)", en: "Flash TTS (cheaper)" },
  { id: "gemini-2.5-pro-preview-tts", ru: "Pro TTS (выше качество)", en: "Pro TTS (higher quality)" },
];

// Gemini prebuilt TTS voices (subset) with a short character hint.
const GEMINI_VOICES: { name: string; ru: string; en: string }[] = [
  { name: "Kore", ru: "твёрдый", en: "firm" },
  { name: "Puck", ru: "бодрый", en: "upbeat" },
  { name: "Charon", ru: "информативный", en: "informative" },
  { name: "Zephyr", ru: "яркий", en: "bright" },
  { name: "Fenrir", ru: "энергичный", en: "excitable" },
  { name: "Leda", ru: "молодой", en: "youthful" },
  { name: "Orus", ru: "уверенный", en: "firm" },
  { name: "Aoede", ru: "лёгкий", en: "breezy" },
];

function SettingsModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [lang, setLang] = useLang();
  const [braveKey, setBraveKey] = useState("");
  const [braveConfigured, setBraveConfigured] = useState(false);
  const [savingBrave, setSavingBrave] = useState(false);
  const [geminiKey, setGeminiKey] = useState("");
  const [geminiConfigured, setGeminiConfigured] = useState(false);
  const [savingGemini, setSavingGemini] = useState(false);
  const [ttsEngine, setTtsEngine] = useState<"system" | "gemini">("system");
  const [ttsVoice, setTtsVoice] = useState("Kore");
  const [geminiImageModel, setGeminiImageModel] = useState("gemini-2.5-flash-image");
  const [geminiTtsModel, setGeminiTtsModel] = useState("gemini-2.5-flash-preview-tts");
  const [imageModelList, setImageModelList] = useState<{ id: string; label: string }[]>([]);
  const [ttsModelList, setTtsModelList] = useState<{ id: string; label: string }[]>([]);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareQr, setShareQr] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [shareErr, setShareErr] = useState<string | null>(null);
  const [shareDomains, setShareDomains] = useState<string[]>([]);
  const [shareDomain, setShareDomain] = useState("");
  const [newDomain, setNewDomain] = useState("");
  const [models, setModels] = useState<ModelConfig | null>(null);
  const [modelBackend, setModelBackend] = useState<ModelBackend>("claude");
  const [modelList, setModelList] = useState<Record<ModelBackend, ModelInfoLite[] | null>>({
    claude: null,
    codex: null,
  });

  useEffect(() => {
    if (modelList[modelBackend] !== null) return;
    invoke<{ models: ModelInfoLite[] }>("sidecar_call", {
      method: "list_models",
      params: { backend: modelBackend },
    })
      .then((r) => setModelList((p) => ({ ...p, [modelBackend]: r.models ?? [] })))
      .catch(() => setModelList((p) => ({ ...p, [modelBackend]: [] })));
  }, [modelBackend, modelList]);

  useEffect(() => {
    invoke<{
      brave_configured: boolean;
      gemini_configured: boolean;
      tts_engine: string;
      tts_voice: string;
      gemini_image_model: string;
      gemini_tts_model: string;
    }>("get_settings_status")
      .then((s) => {
        setBraveConfigured(s.brave_configured);
        setGeminiConfigured(s.gemini_configured);
        setTtsEngine(s.tts_engine === "gemini" ? "gemini" : "system");
        if (s.tts_voice) setTtsVoice(s.tts_voice);
        if (s.gemini_image_model) setGeminiImageModel(s.gemini_image_model);
        if (s.gemini_tts_model) setGeminiTtsModel(s.gemini_tts_model);
      })
      .catch(() => {});
    invoke<ModelConfig>("get_model_settings")
      .then(setModels)
      .catch(() => {});
    if (isTauri) {
      invoke<{ url: string | null }>("share_status")
        .then((s) => setShareUrl(s.url))
        .catch(() => {});
      invoke<{ domains: string[]; selected: string | null }>("get_share_settings")
        .then((s) => {
          setShareDomains(s.domains);
          setShareDomain(s.selected ?? "");
        })
        .catch(() => {});
    }
  }, []);

  useEffect(() => {
    if (!shareUrl) {
      setShareQr(null);
      return;
    }
    QRCode.toDataURL(shareUrl, { width: 220, margin: 1 })
      .then(setShareQr)
      .catch(() => setShareQr(null));
  }, [shareUrl]);

  // Fetch the real Gemini model catalog for the configured key, so the
  // dropdowns show what's actually available (with curated fallbacks if the
  // call fails or key absent).
  useEffect(() => {
    if (!geminiConfigured) {
      setImageModelList([]);
      setTtsModelList([]);
      return;
    }
    invoke<{ image: { id: string; label: string }[]; tts: { id: string; label: string }[] }>(
      "list_gemini_models"
    )
      .then((r) => {
        setImageModelList(r.image ?? []);
        setTtsModelList(r.tts ?? []);
      })
      .catch(() => {
        setImageModelList([]);
        setTtsModelList([]);
      });
  }, [geminiConfigured]);

  async function saveBrave(key: string | null) {
    setSavingBrave(true);
    try {
      const s = await invoke<{ brave_configured: boolean }>("set_brave_key", { key });
      setBraveConfigured(s.brave_configured);
      setBraveKey("");
    } finally {
      setSavingBrave(false);
    }
  }

  async function saveGemini(key: string | null) {
    setSavingGemini(true);
    try {
      const s = await invoke<{ gemini_configured: boolean }>("set_gemini_key", { key });
      setGeminiConfigured(s.gemini_configured);
      setGeminiKey("");
    } finally {
      setSavingGemini(false);
    }
  }

  async function saveTts(eng: "system" | "gemini") {
    setTtsEngine(eng);
    try {
      await invoke("set_tts_engine", { engine: eng });
    } catch {
      /* ignore */
    }
  }

  async function saveTtsVoice(v: string) {
    setTtsVoice(v);
    try {
      await invoke("set_tts_voice", { voice: v });
    } catch {
      /* ignore */
    }
  }

  async function saveGeminiImageModel(m: string) {
    setGeminiImageModel(m);
    try {
      await invoke("set_gemini_image_model", { model: m });
    } catch {
      /* ignore */
    }
  }

  async function saveGeminiTtsModel(m: string) {
    setGeminiTtsModel(m);
    try {
      await invoke("set_gemini_tts_model", { model: m });
    } catch {
      /* ignore */
    }
  }

  function ensureSelected(
    opts: { id: string; label: string }[],
    sel: string
  ): { id: string; label: string }[] {
    if (!sel || opts.some((o) => o.id === sel)) return opts;
    return [{ id: sel, label: sel }, ...opts];
  }

  const imageOptions = ensureSelected(
    imageModelList.length
      ? imageModelList
      : GEMINI_IMAGE_MODELS.map((m) => ({ id: m.id, label: lang === "ru" ? m.ru : m.en })),
    geminiImageModel
  );
  const ttsOptions = ensureSelected(
    ttsModelList.length
      ? ttsModelList
      : GEMINI_TTS_MODELS.map((m) => ({ id: m.id, label: lang === "ru" ? m.ru : m.en })),
    geminiTtsModel
  );

  async function startShare() {
    setSharing(true);
    setShareErr(null);
    try {
      const s = await invoke<{ url: string | null }>("start_share", {
        domain: shareDomain || null,
      });
      setShareUrl(s.url);
    } catch (e) {
      setShareErr(String(e));
    } finally {
      setSharing(false);
    }
  }

  async function stopShare() {
    setSharing(true);
    try {
      await invoke("stop_share");
      setShareUrl(null);
    } finally {
      setSharing(false);
    }
  }

  async function addDomain() {
    const d = newDomain.trim();
    if (!d) return;
    const s = await invoke<{ domains: string[]; selected: string | null }>(
      "set_share_domains",
      { domains: [...shareDomains, d] }
    );
    setShareDomains(s.domains);
    setShareDomain(d);
    setNewDomain("");
  }

  async function removeDomain(d: string) {
    const s = await invoke<{ domains: string[]; selected: string | null }>(
      "set_share_domains",
      { domains: shareDomains.filter((x) => x !== d) }
    );
    setShareDomains(s.domains);
    if (shareDomain === d) setShareDomain(s.selected ?? "");
  }

  function patchModel(cat: ModelCategory, patch: Partial<StageModel>, save: boolean) {
    if (!models) return;
    const next: ModelConfig = {
      ...models,
      [modelBackend]: {
        ...models[modelBackend],
        [cat]: { ...models[modelBackend][cat], ...patch },
      },
    };
    setModels(next);
    if (save) invoke("set_model_settings", { models: next }).catch(() => {});
  }

  function effortLevelsFor(modelValue: string | null): string[] {
    const list = modelList[modelBackend] ?? [];
    const m =
      list.find((x) => x.value === (modelValue || "")) ||
      list.find((x) => x.value === "default") ||
      list[0];
    return m?.effortLevels ?? [];
  }

  return (
    <div className="settings-overlay" role="dialog" aria-modal="true">
      <div className="settings-header">
        <h2>{t("settingsTitle")}</h2>
        <button className="settings-close" onClick={onClose} aria-label={t("close")}>
          ✕
        </button>
      </div>
      <div className="settings-body">
        <div className="settings-content">

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

        <div className="setting-group">
          <div className="setting-label">{t("braveTitle")}</div>
          <div className="brave-row">
            <input
              type="password"
              className="custom-answer"
              value={braveKey}
              placeholder={braveConfigured ? "•••••••••" : t("bravePlaceholder")}
              onChange={(e) => setBraveKey(e.target.value)}
              disabled={savingBrave}
            />
            <button
              onClick={() => saveBrave(braveKey)}
              disabled={!braveKey.trim() || savingBrave}
            >
              {t("braveSave")}
            </button>
            {braveConfigured && (
              <button
                className="ghost"
                onClick={() => saveBrave(null)}
                disabled={savingBrave}
              >
                {t("braveClear")}
              </button>
            )}
          </div>
          {braveConfigured && !braveKey && (
            <div className="setting-note success-note">✓ {t("braveConfigured")}</div>
          )}
          <div className="setting-note">{t("braveNote")}</div>
        </div>

        <div className="setting-group">
          <div className="setting-label">{t("geminiTitle")}</div>
          <div className="brave-row">
            <input
              type="password"
              className="custom-answer"
              value={geminiKey}
              placeholder={geminiConfigured ? "•••••••••" : t("geminiPlaceholder")}
              onChange={(e) => setGeminiKey(e.target.value)}
              disabled={savingGemini}
            />
            <button
              onClick={() => saveGemini(geminiKey)}
              disabled={!geminiKey.trim() || savingGemini}
            >
              {t("braveSave")}
            </button>
            {geminiConfigured && (
              <button className="ghost" onClick={() => saveGemini(null)} disabled={savingGemini}>
                {t("braveClear")}
              </button>
            )}
          </div>
          {geminiConfigured && !geminiKey && (
            <div className="setting-note success-note">✓ {t("geminiConfigured")}</div>
          )}
          <div className="setting-note">{t("geminiNote")}</div>
          {geminiConfigured && (
            <div className="tts-voice-row">
              <span className="setting-note">{t("geminiImageModelLabel")}</span>
              <select
                className="tts-voice-select"
                value={geminiImageModel}
                onChange={(e) => saveGeminiImageModel(e.target.value)}
              >
                {imageOptions.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id === m.label ? m.id : `${m.id} — ${m.label}`}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        <div className="setting-group">
          <div className="setting-label">{t("ttsTitle")}</div>
          <div className="lang-picker">
            <button
              className={`lang-option ${ttsEngine === "system" ? "active" : ""}`}
              onClick={() => saveTts("system")}
            >
              {t("ttsSystem")}
            </button>
            <button
              className={`lang-option ${ttsEngine === "gemini" ? "active" : ""}`}
              onClick={() => geminiConfigured && saveTts("gemini")}
              disabled={!geminiConfigured}
              title={!geminiConfigured ? t("ttsGeminiNeedsKey") : undefined}
            >
              {t("ttsGemini")}
            </button>
          </div>
          <div className="setting-note">{t("ttsNote")}</div>
          {!geminiConfigured && <div className="setting-note warn-note">⚠ {t("ttsGeminiNeedsKey")}</div>}
          {geminiConfigured && ttsEngine === "gemini" && (
            <>
              <div className="tts-voice-row">
                <span className="setting-note">{t("ttsModelLabel")}</span>
                <select
                  className="tts-voice-select"
                  value={geminiTtsModel}
                  onChange={(e) => saveGeminiTtsModel(e.target.value)}
                >
                  {ttsOptions.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id === m.label ? m.id : `${m.id} — ${m.label}`}
                    </option>
                  ))}
                </select>
              </div>
              <div className="tts-voice-row">
                <span className="setting-note">{t("ttsVoiceLabel")}</span>
                <select
                  className="tts-voice-select"
                  value={ttsVoice}
                  onChange={(e) => saveTtsVoice(e.target.value)}
                >
                  {GEMINI_VOICES.map((v) => (
                    <option key={v.name} value={v.name}>
                      {v.name} — {lang === "ru" ? v.ru : v.en}
                    </option>
                  ))}
                </select>
              </div>
            </>
          )}
        </div>

        {models && (
          <div className="setting-group">
            <div className="setting-label">{t("modelsTitle")}</div>
            <div className="lang-picker">
              {(["claude", "codex"] as const).map((b) => (
                <button
                  key={b}
                  className={`lang-option ${modelBackend === b ? "active" : ""}`}
                  onClick={() => setModelBackend(b)}
                >
                  {b === "claude" ? "Claude" : "Codex"}
                </button>
              ))}
            </div>
            {(["planning", "writing", "tests"] as const).map((cat) => {
              const sm = models[modelBackend][cat];
              const list = modelList[modelBackend];
              const loading = list === null;
              const levels = effortLevelsFor(sm.model);
              const defaultEntry = (list ?? []).find((m) => m.value === "default");
              const defaultName = defaultEntry?.description?.split("·")[0]?.trim();
              const defaultLabel = defaultName
                ? `${t("modelsDefault")} · ${defaultName}`
                : t("modelsDefault");
              const catLabel =
                cat === "planning"
                  ? t("modelsCatPlanning")
                  : cat === "writing"
                    ? t("modelsCatWriting")
                    : t("modelsCatTests");
              return (
                <div className="model-row" key={cat}>
                  <span className="model-cat">{catLabel}</span>
                  <select
                    className="model-name"
                    disabled={loading}
                    value={sm.model ?? ""}
                    onChange={(e) =>
                      patchModel(cat, { model: e.target.value || null, reasoning: null }, true)
                    }
                  >
                    <option value="">{loading ? t("modelsLoading") : defaultLabel}</option>
                    {(list ?? []).map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                  <select
                    className="model-reasoning"
                    disabled={loading || levels.length === 0}
                    value={sm.reasoning ?? ""}
                    onChange={(e) =>
                      patchModel(cat, { reasoning: e.target.value || null }, true)
                    }
                  >
                    <option value="">{t("modelsReasoningDefault")}</option>
                    {levels.map((l) => (
                      <option key={l} value={l}>
                        {l.charAt(0).toUpperCase() + l.slice(1)}
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
            <div className="setting-note">{t("modelsNote")}</div>
          </div>
        )}

        {isTauri && (
          <div className="setting-group">
            <div className="setting-label">{t("shareTitle")}</div>
            {!shareUrl ? (
              <>
                <div className="domain-chips">
                  <button
                    className={`domain-chip ${shareDomain === "" ? "active" : ""}`}
                    onClick={() => setShareDomain("")}
                  >
                    {t("shareDomainAuto")}
                  </button>
                  {shareDomains.map((d) => (
                    <span
                      key={d}
                      className={`domain-chip ${shareDomain === d ? "active" : ""}`}
                    >
                      <button className="domain-chip-label" onClick={() => setShareDomain(d)}>
                        {d}
                      </button>
                      <button
                        className="domain-chip-x"
                        title={t("shareRemove")}
                        onClick={() => removeDomain(d)}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
                <div className="brave-row">
                  <input
                    className="custom-answer"
                    value={newDomain}
                    placeholder={t("shareAddDomain")}
                    onChange={(e) => setNewDomain(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") addDomain();
                    }}
                  />
                  <button onClick={addDomain} disabled={!newDomain.trim()}>
                    {t("shareAdd")}
                  </button>
                </div>
                <button className="share-start-btn" onClick={startShare} disabled={sharing}>
                  {sharing ? t("shareStarting") : t("shareStart")}
                </button>
              </>
            ) : (
              <div className="share-active">
                {shareQr && <img className="share-qr" src={shareQr} alt="QR" width={220} height={220} />}
                <a className="share-url" href={shareUrl} target="_blank" rel="noreferrer">
                  {shareUrl}
                </a>
                <div className="brave-row">
                  <button onClick={() => navigator.clipboard?.writeText(shareUrl)}>
                    {t("shareCopy")}
                  </button>
                  <button className="ghost" onClick={stopShare} disabled={sharing}>
                    {t("shareStop")}
                  </button>
                </div>
              </div>
            )}
            {shareErr && <div className="setting-note error-note">{shareErr}</div>}
            <div className="setting-note">{t("shareNote")}</div>
          </div>
        )}

          <div className="modal-actions">
            <button onClick={onClose}>{t("close")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function CreateCourse({
  agentAvail,
  onCreated,
  onCancel,
}: {
  agentAvail: { claude: boolean; codex: boolean } | null;
  onCreated: (id: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const initialAgent: Agent = agentAvail?.claude ? "claude" : agentAvail?.codex ? "codex" : "claude";
  const [topic, setTopic] = useState("");
  const [agent, setAgent] = useState<Agent>(initialAgent);
  const [busy, setBusy] = useState(false);

  // If agentAvail loads after first render and the selected agent is
  // unavailable, swap to whichever is available.
  useEffect(() => {
    if (!agentAvail) return;
    if (agent === "claude" && !agentAvail.claude && agentAvail.codex) setAgent("codex");
    else if (agent === "codex" && !agentAvail.codex && agentAvail.claude) setAgent("claude");
  }, [agentAvail, agent]);

  const claudeOk = agentAvail?.claude !== false;
  const codexOk = agentAvail?.codex !== false;
  const selectedAvail =
    agentAvail === null
      ? true
      : agent === "claude"
        ? agentAvail.claude
        : agentAvail.codex;
  const noAgents = agentAvail !== null && !claudeOk && !codexOk;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!topic.trim() || busy || !selectedAvail || noAgents) return;
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
          <label
            className={`agent-option ${agent === "claude" ? "selected" : ""} ${
              !claudeOk ? "disabled" : ""
            }`}
          >
            <input
              type="radio"
              name="agent"
              value="claude"
              checked={agent === "claude"}
              onChange={() => claudeOk && setAgent("claude")}
              disabled={!claudeOk}
            />
            <div className="agent-meta">
              <div className="agent-name">
                Claude
                <AgentAvailBadge available={claudeOk} />
              </div>
              <div className="agent-desc">{t("claudeDesc")}</div>
            </div>
          </label>
          <label
            className={`agent-option ${agent === "codex" ? "selected" : ""} ${
              !codexOk ? "disabled" : ""
            }`}
          >
            <input
              type="radio"
              name="agent"
              value="codex"
              checked={agent === "codex"}
              onChange={() => codexOk && setAgent("codex")}
              disabled={!codexOk}
            />
            <div className="agent-meta">
              <div className="agent-name">
                Codex
                <AgentAvailBadge available={codexOk} />
              </div>
              <div className="agent-desc">{t("codexDesc")}</div>
            </div>
          </label>
        </div>
      </label>
      {noAgents && (
        <div className="form-error">{t("noAgentsBody")}</div>
      )}
      <div className="actions">
        <button
          type="submit"
          disabled={!topic.trim() || busy || !selectedAvail || noAgents}
        >
          {t("create")}
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          {t("cancel")}
        </button>
      </div>
    </form>
  );
}

function AgentAvailBadge({ available }: { available: boolean }) {
  const t = useT();
  return (
    <span className={`agent-avail ${available ? "ok" : "no"}`}>
      {available ? t("agentAvailable") : t("agentUnavailable")}
    </span>
  );
}

function CourseView({
  course,
  jobs,
  structureTranscript,
  onStartJob,
  onChanged,
  onOpenSub,
  onStartSubGen,
  onDeleted,
}: {
  course?: Course;
  jobs: Map<string, JobState>;
  structureTranscript: Bubble[] | null;
  onStartJob: (kind: JobKind) => void;
  onChanged: () => void | Promise<void>;
  onOpenSub: (moduleId: string, submoduleId: string) => void;
  onStartSubGen: (submoduleId: string) => void | Promise<void>;
  onDeleted: () => void | Promise<void>;
}) {
  const t = useT();
  const [confirmDelete, setConfirmDelete] = useState(false);
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
        <select
          className={`agent-pill agent-select agent-${course.agent}`}
          value={course.agent}
          title={t("switchProvider")}
          onChange={async (e) => {
            await invoke("set_course_agent", { courseId: course.id, agent: e.target.value });
            await onChanged();
          }}
        >
          <option value="claude">claude</option>
          <option value="codex">codex</option>
        </select>
        <span className={`status-pill status-${course.status}`}>
          {statusLabel[course.status] ?? course.status}
        </span>
      </div>
      {course.status === "wizard" && (
        <Wizard
          course={course}
          job={jobs.get(jobKey(course.id, "wizard_questions"))}
          transcript={structureTranscript}
          onStart={() => onStartJob("wizard_questions")}
          onSaved={onChanged}
        />
      )}
      {course.status === "structuring" && (
        <StructureBuilder
          job={jobs.get(jobKey(course.id, "build_structure"))}
          transcript={structureTranscript}
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

      <div className="course-danger-zone">
        <button className="danger-link" onClick={() => setConfirmDelete(true)}>
          {t("deleteCourse")}
        </button>
      </div>

      {confirmDelete && (
        <DeleteCourseModal
          course={course}
          onCancel={() => setConfirmDelete(false)}
          onDeleted={async () => {
            setConfirmDelete(false);
            await onDeleted();
          }}
        />
      )}
    </div>
  );
}

function DeleteCourseModal({
  course,
  onCancel,
  onDeleted,
}: {
  course: Course;
  onCancel: () => void;
  onDeleted: () => void | Promise<void>;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await invoke("delete_course", { courseId: course.id });
      await onDeleted();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="alertdialog" aria-modal="true">
        <h2>{t("deleteCourseTitle", { topic: course.topic })}</h2>
        <p className="setting-note">{t("deleteCourseWarning")}</p>
        {error && <p className="error-banner">{t("errorPrefix", { error })}</p>}
        <div className="modal-actions">
          <button onClick={onCancel} disabled={busy}>
            {t("cancel")}
          </button>
          <button className="danger" onClick={confirm} disabled={busy}>
            {busy ? t("deleting") : t("deleteConfirm")}
          </button>
        </div>
      </div>
    </div>
  );
}

function Wizard({
  course,
  job,
  transcript,
  onStart,
  onSaved,
}: {
  course: Course;
  job?: JobState;
  transcript: Bubble[] | null;
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
        <AgentTranscript transcript={transcript} />
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

type Answer = { selected: number[]; custom: string };

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
    questions.map(() => ({ selected: [], custom: "" }))
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function setAnswer(i: number, patch: Partial<Answer>) {
    setAnswers((prev) => prev.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  }

  function toggleOption(i: number, optIdx: number) {
    const q = questions[i];
    const isMulti = q.multi !== false;
    const cur = answers[i].selected;
    if (isMulti) {
      const has = cur.includes(optIdx);
      setAnswer(i, {
        selected: has ? cur.filter((x) => x !== optIdx) : [...cur, optIdx].sort((a, b) => a - b),
      });
    } else {
      setAnswer(i, { selected: cur[0] === optIdx ? [] : [optIdx] });
    }
  }

  function resolveAnswer(i: number): string {
    const q = questions[i];
    const a = answers[i];
    const custom = a.custom.trim();
    const picked = a.selected.map((idx) => q.options[idx]).filter(Boolean);
    if (picked.length === 0 && !custom) return "";
    if (picked.length === 0) return custom;
    const joined = picked.join(", ");
    if (!custom) return joined;
    return `${joined}; ${custom}`;
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
        {questions.map((q, i) => {
          const isMulti = q.multi !== false;
          return (
            <li key={i}>
              <div className="q">
                {q.text}
                <span className={`q-mode q-mode-${isMulti ? "multi" : "single"}`}>
                  {isMulti ? t("optMulti") : t("optSingle")}
                </span>
              </div>
              <div className="options">
                {q.options.map((opt, j) => (
                  <label key={j} className="option">
                    <input
                      type={isMulti ? "checkbox" : "radio"}
                      name={isMulti ? undefined : `q-${i}`}
                      checked={answers[i].selected.includes(j)}
                      onChange={() => toggleOption(i, j)}
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
          );
        })}
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
  transcript,
  onStart,
}: {
  job?: JobState;
  transcript: Bubble[] | null;
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
      {running && <AgentTranscript transcript={transcript} />}
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
      // Goal hook: after the user accepts a refined plan, kick off the
      // first submodule generation automatically. (Initial build also
      // triggers the same in App.tsx.)
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
                      {s.test_passed ? (
                        <span className="learned-dot" title="изучено">
                          ✓
                        </span>
                      ) : (
                        <SubmoduleStateIcon state={s.generation_state} />
                      )}
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
  sources: Source[];
  test: TestQuestion[];
  review_notes: string;
};

type WidgetData =
  | { type: "image"; placeholder?: boolean; description?: string; alt?: string; url?: string; source?: string }
  | { type: "diagram"; source: string; caption?: string; error?: string }
  | { type: "video"; url: string; title?: string; recommended_by?: string; why?: string }
  | {
      type: "interactive";
      title?: string;
      description?: string;
      html: string;
      css: string;
      js: string;
      height?: number;
      error?: string;
    }
  | { type: string; [k: string]: any };

type Source = { title: string; url: string };

type AssignmentType = "image" | "text" | "document" | "archive" | "github";
type Criticality = "critical" | "major" | "minor";
type AssignmentRemark = { text: string; criticality: Criticality };
type AssignmentTurn =
  | {
      role: "user";
      ts: number;
      kind: "submission";
      submissionType: AssignmentType;
      text?: string;
      files?: { name: string; path: string }[];
      githubUrl?: string;
    }
  | {
      role: "agent";
      ts: number;
      kind: "review";
      verdict: "passed" | "revise";
      summary: string;
      remarks: AssignmentRemark[];
    };
type Assignment = {
  id: string;
  title: string;
  prompt: string;
  type: AssignmentType;
  criteria: string;
  status: "pending" | "in_progress" | "passed";
  chat: AssignmentTurn[];
};

function SubmoduleView({
  course,
  moduleId,
  submoduleId,
  stageDetail,
  transcript,
  lastError,
  enriching,
  onStartGen,
}: {
  course?: Course;
  moduleId: string;
  submoduleId: string;
  stageDetail: StageDetail | null;
  transcript: Bubble[] | null;
  lastError: string | null;
  enriching: boolean;
  onStartGen: (submoduleId: string) => void | Promise<void>;
}) {
  const t = useT();
  const [tree, setTree] = useState<StructureFile | null>(null);
  const [content, setContent] = useState<SubmoduleContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingRegen, setConfirmingRegen] = useState(false);
  const [savedError, setSavedError] = useState<string | null>(null);
  const [fontPx, setFontPx] = useState(
    () => Number(localStorage.getItem("readerFontPx")) || 16
  );
  const setFont = (px: number) => {
    const v = Math.max(13, Math.min(24, px));
    setFontPx(v);
    localStorage.setItem("readerFontPx", String(v));
  };

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

  // Load the persisted failure error so the failed screen shows what happened
  // even after a reopen (the live event is only in memory).
  useEffect(() => {
    if (!course || state !== "failed") {
      setSavedError(null);
      return;
    }
    invoke<string | null>("read_submodule_error", {
      courseId: course.id,
      moduleId,
      submoduleId,
    })
      .then((e) => setSavedError(e ?? null))
      .catch(() => setSavedError(null));
  }, [course, state, moduleId, submoduleId]);

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

  // Refresh tree as soon as Rust emits the first stage event for this sub —
  // that's when the row flips from 'pending' to 'generating' and we should
  // transition the page from the empty card to the stage strip.
  useEffect(() => {
    if (!course) return;
    const unl = listen<StageEvent>("agent_stage", async (e) => {
      const p = e.payload;
      if (p.courseId !== course.id || p.submoduleId !== submoduleId) return;
      // Flip pending/failed → generating on the first stage event. Skip when
      // already ready (background enrichment emits illustrate/test stages too).
      if (state !== "generating" && state !== "ready") await reloadTree();
    });
    return () => {
      unl.then((f) => f());
    };
  }, [course, submoduleId, reloadTree, state]);

  // Background enrichment finished — pull in the images + test that just landed.
  useEffect(() => {
    if (!course) return;
    const unl = listen<{ courseId: string; submoduleId: string }>(
      "agent_enrich",
      async (e) => {
        const p = e.payload;
        if (p.courseId !== course.id || p.submoduleId !== submoduleId) return;
        await reloadTree();
        await reloadContent();
      }
    );
    return () => {
      unl.then((f) => f());
    };
  }, [course, submoduleId, reloadTree, reloadContent]);

  if (!course) return <div className="placeholder">{t("courseNotFound")}</div>;
  if (!sub && !tree) return <div className="placeholder">{t("loadingStructure")}</div>;
  if (!sub) return <div className="placeholder">{t("courseNotFound")}</div>;

  const moduleIdx = tree!.modules.findIndex((m) => m.id === moduleId);
  const subIdx =
    tree!.modules[moduleIdx]?.submodules.findIndex((s) => s.id === submoduleId) ?? 0;

  return (
    <div className="submodule-view">
      <div className="sub-numbering">
        {moduleIdx + 1}.{subIdx + 1}
        {sub.test_passed && <span className="learned-badge">✓ {t("subLearned")}</span>}
      </div>
      <h1 className="sub-h1">{sub.title}</h1>
      {sub.summary && <div className="sub-lead">{sub.summary}</div>}

      {(state === "pending" || state === "failed") && (
        <div className="sub-empty">
          <p>
            {state === "failed" ? t("stageFailedHint") : t("stagePendingHint")}
          </p>
          {state === "failed" && (lastError || savedError) && (
            <pre className="sub-error">{lastError || savedError}</pre>
          )}
          <button
            onClick={async () => {
              await onStartGen(submoduleId);
              await reloadTree();
            }}
          >
            {state === "failed" ? t("subContinue") : t("subGenerate")}
          </button>
          {error && <p className="error-banner">{t("errorPrefix", { error })}</p>}
        </div>
      )}

      {state === "generating" && (
        <div className="sub-generating">
          <StageStrip current={stageDetail?.stage ?? "draft"} />
          <LiveActivity stageDetail={stageDetail} />
          <AgentTranscript transcript={transcript} />
        </div>
      )}

      {state === "ready" && (
        <>
          <div className="sub-actions">
            <div className="font-control" title={t("fontSize")}>
              <button onClick={() => setFont(fontPx - 1)} aria-label="A−">A−</button>
              <button onClick={() => setFont(fontPx + 1)} aria-label="A+">A+</button>
            </div>
            {content && (
              <LectureAudio article={content.article} lang={course.language} title={sub.title} />
            )}
            <span className="sub-actions-spacer" />
            {confirmingRegen ? (
              <>
                <span className="sub-regen-warn">{t("subRegenerateConfirm")}</span>
                <button
                  className="sub-regenerate danger"
                  onClick={async () => {
                    setConfirmingRegen(false);
                    await onStartGen(submoduleId);
                    await reloadTree();
                  }}
                >
                  ↻ {t("subRegenerate")}
                </button>
                <button className="sub-regenerate" onClick={() => setConfirmingRegen(false)}>
                  {t("cancel")}
                </button>
              </>
            ) : (
              <button className="sub-regenerate" onClick={() => setConfirmingRegen(true)}>
                ↻ {t("subRegenerate")}
              </button>
            )}
          </div>
          {enriching && (
            <div className="sub-enriching">
              <span className="spinner" />
              {t("subEnriching")}
            </div>
          )}
          {!content && <div className="placeholder">{t("loadingStructure")}</div>}
          {content && (
            <>
              <ArticleReader
                article={content.article}
                widgets={content.widgets}
                fontPx={fontPx}
              />
              {content.sources?.length > 0 && (
                <SourcesList sources={content.sources} />
              )}
              {content.test?.length > 0 && (
                <TestSection
                  questions={content.test}
                  alreadyPassed={!!sub.test_passed}
                  onPassed={async () => {
                    await invoke("submit_test_result", {
                      submoduleId: submoduleId,
                      passed: true,
                    });
                    await reloadTree();
                  }}
                />
              )}
              <AssignmentsSection
                courseId={course.id}
                moduleId={moduleId}
                submoduleId={submoduleId}
              />
            </>
          )}
        </>
      )}
    </div>
  );
}

// Strip markdown + widget markers to plain prose suitable for text-to-speech.
function articleToSpeechText(md: string): string {
  return (md || "")
    .replace(/^::widget\{[^}]*\}\s*$/gm, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/\$\$[\s\S]*?\$\$/g, " ")
    .replace(/\$[^$\n]*\$/g, " ")
    .replace(/[*_~`>#|]+/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

// Split into ~220-char chunks at sentence/line boundaries — long single
// utterances get truncated by some speech engines, so we queue many short ones.
function chunkSpeech(text: string, maxLen = 220): string[] {
  const parts = text
    .split(/(?<=[.!?…:])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let cur = "";
  for (const p of parts) {
    if (cur && (cur + " " + p).length > maxLen) {
      chunks.push(cur);
      cur = p;
    } else {
      cur = cur ? cur + " " + p : p;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

const SPEECH_LANG: Record<string, string> = { ru: "ru-RU", en: "en-US" };

// ───────────────────────── Global audio player ──────────────────────────
// Playback state lives at App level so audio keeps going while the user
// navigates between submodules. The sticky footer / expanded view render here.
// In-session chunk cache + backend disk cache ensure paid Gemini chunks are
// fetched exactly once.

type PlayerMode = "idle" | "playing" | "paused";
type PlayerState = {
  mode: PlayerMode;
  preparing: boolean;
  engine: "system" | "gemini";
  title: string;
  chunkIdx: number;
  totalChunks: number;
  expanded: boolean;
  /** seconds, within the current chunk (gemini only — 0 for system). */
  currentTime: number;
  /** seconds, length of the current chunk (gemini only — 0 for system). */
  duration: number;
};
type PlayerAPI = {
  state: PlayerState;
  start: (article: string, title: string, lang: string) => void | Promise<void>;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  toggleExpand: () => void;
  /** Skip back N seconds within current chunk; for system engine: prev chunk. */
  skipBack: (seconds?: number) => void;
  /** Skip forward N seconds within current chunk; for system engine: next chunk. */
  skipForward: (seconds?: number) => void;
  /** Seek to absolute t (seconds) in the current chunk (gemini only). */
  seekTo: (t: number) => void;
};
const AudioPlayerCtx = createContext<PlayerAPI | null>(null);
export function useAudioPlayer() {
  const c = useContext(AudioPlayerCtx);
  if (!c) throw new Error("useAudioPlayer outside provider");
  return c;
}

function AudioPlayerProvider({ children }: { children: ReactNode }) {
  const sysSupported = typeof window !== "undefined" && "speechSynthesis" in window;
  const [mode, setMode] = useState<PlayerMode>("idle");
  const [preparing, setPreparing] = useState(false);
  const [engine, setEngine] = useState<"system" | "gemini">("system");
  const [title, setTitle] = useState("");
  const [chunkIdx, setChunkIdx] = useState(0);
  const [totalChunks, setTotalChunks] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [lang, setLang] = useState("en");
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const engineRef = useRef<"system" | "gemini">("system");

  const chunksRef = useRef<string[]>([]);
  const idxRef = useRef(0);
  const ctrlRef = useRef({ paused: false, stopped: false });
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const cacheRef = useRef<Map<number, Promise<string>>>(new Map());

  const speechLang = SPEECH_LANG[(lang || "en").slice(0, 2).toLowerCase()] || lang || "en-US";

  const cancelAll = useCallback(() => {
    if (sysSupported) {
      try {
        window.speechSynthesis.cancel();
      } catch {}
    }
    if (audioRef.current) {
      try {
        audioRef.current.pause();
      } catch {}
    }
  }, [sysSupported]);

  const speakSysFrom = useCallback(
    (i: number) => {
      const chunks = chunksRef.current;
      if (i >= chunks.length) {
        setMode("idle");
        setChunkIdx(0);
        idxRef.current = 0;
        return;
      }
      idxRef.current = i;
      setChunkIdx(i);
      const u = new SpeechSynthesisUtterance(chunks[i]);
      u.lang = speechLang;
      const base = speechLang.slice(0, 2).toLowerCase();
      const v = (window.speechSynthesis.getVoices() || []).find((x) =>
        x.lang?.toLowerCase().startsWith(base)
      );
      if (v) u.voice = v;
      u.onend = () => {
        if (ctrlRef.current.paused || ctrlRef.current.stopped) return;
        speakSysFrom(idxRef.current + 1);
      };
      u.onerror = () => {
        if (ctrlRef.current.paused || ctrlRef.current.stopped) return;
        setMode("idle");
      };
      window.speechSynthesis.speak(u);
    },
    [speechLang]
  );

  const synthChunk = useCallback((j: number): Promise<string> | null => {
    const chunks = chunksRef.current;
    if (j < 0 || j >= chunks.length) return null;
    let p = cacheRef.current.get(j);
    if (!p) {
      p = invoke<string>("synthesize_speech", { text: chunks[j] });
      cacheRef.current.set(j, p);
    }
    return p;
  }, []);

  const playGeminiFrom = useCallback(
    async (i: number) => {
      const chunks = chunksRef.current;
      if (i >= chunks.length) {
        setMode("idle");
        setPreparing(false);
        setChunkIdx(0);
        idxRef.current = 0;
        return;
      }
      idxRef.current = i;
      setChunkIdx(i);
      const cur = synthChunk(i);
      if (!cur) {
        setMode("idle");
        return;
      }
      setPreparing(true);
      let b64: string;
      try {
        b64 = await cur;
      } catch {
        setMode("idle");
        setPreparing(false);
        return;
      }
      if (ctrlRef.current.stopped || ctrlRef.current.paused) {
        setPreparing(false);
        return;
      }
      setPreparing(false);
      synthChunk(i + 1); // prefetch
      const audio = audioRef.current ?? (audioRef.current = new Audio());
      setCurrentTime(0);
      setDuration(0);
      audio.src = `data:audio/wav;base64,${b64}`;
      audio.onended = () => {
        if (ctrlRef.current.paused || ctrlRef.current.stopped) return;
        playGeminiFrom(idxRef.current + 1);
      };
      audio.onerror = () => {
        if (ctrlRef.current.paused || ctrlRef.current.stopped) return;
        setMode("idle");
      };
      audio.onloadedmetadata = () => setDuration(audio.duration || 0);
      audio.ontimeupdate = () => setCurrentTime(audio.currentTime || 0);
      try {
        await audio.play();
      } catch {}
    },
    [synthChunk]
  );

  const start = useCallback(
    async (article: string, articleTitle: string, articleLang: string) => {
      const status = await invoke<{ tts_engine: string; gemini_configured: boolean }>(
        "get_settings_status"
      ).catch(() => null);
      const eng: "system" | "gemini" =
        status && status.tts_engine === "gemini" && status.gemini_configured ? "gemini" : "system";
      const text = articleToSpeechText(article);
      const chunks = chunkSpeech(text, eng === "gemini" ? 1600 : 220);
      if (chunks.length === 0) return;
      chunksRef.current = chunks;
      cacheRef.current = new Map();
      ctrlRef.current = { paused: false, stopped: false };
      cancelAll();
      engineRef.current = eng;
      setEngine(eng);
      setLang(articleLang);
      setTitle(articleTitle);
      setTotalChunks(chunks.length);
      setChunkIdx(0);
      setCurrentTime(0);
      setDuration(0);
      setMode("playing");
      setPreparing(false);
      if (eng === "gemini") playGeminiFrom(0);
      else speakSysFrom(0);
    },
    [cancelAll, playGeminiFrom, speakSysFrom]
  );

  const pause = useCallback(() => {
    ctrlRef.current.paused = true;
    if (engineRef.current === "gemini") audioRef.current?.pause();
    else if (sysSupported) {
      try {
        window.speechSynthesis.cancel();
      } catch {}
    }
    setMode("paused");
  }, [sysSupported]);

  const resume = useCallback(() => {
    ctrlRef.current.paused = false;
    setMode("playing");
    if (engineRef.current === "gemini") {
      const a = audioRef.current;
      if (a && a.src && !a.ended && a.currentTime > 0)
        a.play().catch(() => playGeminiFrom(idxRef.current));
      else playGeminiFrom(idxRef.current);
    } else {
      speakSysFrom(idxRef.current);
    }
  }, [playGeminiFrom, speakSysFrom]);

  const stop = useCallback(() => {
    ctrlRef.current.stopped = true;
    cancelAll();
    if (audioRef.current) audioRef.current.src = "";
    cacheRef.current = new Map();
    setPreparing(false);
    setMode("idle");
    setExpanded(false);
    setChunkIdx(0);
    setCurrentTime(0);
    setDuration(0);
    idxRef.current = 0;
  }, [cancelAll]);

  const toggleExpand = useCallback(() => setExpanded((x) => !x), []);

  const skipBack = useCallback(
    (seconds: number = 10) => {
      if (engineRef.current === "gemini") {
        const a = audioRef.current;
        if (!a) return;
        const next = (a.currentTime || 0) - seconds;
        if (next >= 0) {
          a.currentTime = next;
          setCurrentTime(next);
        } else if (idxRef.current > 0) {
          // Cross-chunk back: jump to start of previous chunk.
          ctrlRef.current.paused = false;
          ctrlRef.current.stopped = false;
          setMode("playing");
          playGeminiFrom(idxRef.current - 1);
        } else {
          a.currentTime = 0;
          setCurrentTime(0);
        }
      } else {
        // System: ±10s isn't possible inside an utterance — jump a chunk.
        if (!sysSupported) return;
        try {
          window.speechSynthesis.cancel();
        } catch {}
        ctrlRef.current.paused = false;
        ctrlRef.current.stopped = false;
        setMode("playing");
        speakSysFrom(Math.max(0, idxRef.current - 1));
      }
    },
    [playGeminiFrom, speakSysFrom, sysSupported]
  );

  const skipForward = useCallback(
    (seconds: number = 10) => {
      if (engineRef.current === "gemini") {
        const a = audioRef.current;
        if (!a) return;
        const dur = a.duration || 0;
        const next = (a.currentTime || 0) + seconds;
        if (dur > 0 && next < dur) {
          a.currentTime = next;
          setCurrentTime(next);
        } else {
          ctrlRef.current.paused = false;
          ctrlRef.current.stopped = false;
          setMode("playing");
          playGeminiFrom(idxRef.current + 1);
        }
      } else {
        if (!sysSupported) return;
        try {
          window.speechSynthesis.cancel();
        } catch {}
        ctrlRef.current.paused = false;
        ctrlRef.current.stopped = false;
        setMode("playing");
        speakSysFrom(idxRef.current + 1);
      }
    },
    [playGeminiFrom, speakSysFrom, sysSupported]
  );

  const seekTo = useCallback((t: number) => {
    if (engineRef.current !== "gemini") return;
    const a = audioRef.current;
    if (!a) return;
    const clamped = Math.max(0, Math.min(t, a.duration || t));
    a.currentTime = clamped;
    setCurrentTime(clamped);
  }, []);

  const api: PlayerAPI = useMemo(
    () => ({
      state: {
        mode,
        preparing,
        engine,
        title,
        chunkIdx,
        totalChunks,
        expanded,
        currentTime,
        duration,
      },
      start,
      pause,
      resume,
      stop,
      toggleExpand,
      skipBack,
      skipForward,
      seekTo,
    }),
    [
      mode,
      preparing,
      engine,
      title,
      chunkIdx,
      totalChunks,
      expanded,
      currentTime,
      duration,
      start,
      pause,
      resume,
      stop,
      toggleExpand,
      skipBack,
      skipForward,
      seekTo,
    ]
  );

  return (
    <AudioPlayerCtx.Provider value={api}>
      {children}
      {mode !== "idle" && !expanded && <StickyPlayer />}
      {mode !== "idle" && expanded && <ExpandedPlayer />}
    </AudioPlayerCtx.Provider>
  );
}

function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function StickyPlayer() {
  const t = useT();
  const p = useAudioPlayer();
  const s = p.state;
  const hasScrubber = s.engine === "gemini" && s.duration > 0;
  const pct = hasScrubber ? Math.min(100, (s.currentTime / s.duration) * 100) : 0;
  return (
    <div className="audio-sticky">
      <div className="audio-sticky-row">
        <div className="audio-sticky-meta">
          <span className="audio-sticky-engine">{s.engine === "gemini" ? "🎙" : "🔊"}</span>
          <span className="audio-sticky-title" title={s.title}>{s.title}</span>
          {s.totalChunks > 0 && (
            <span className="audio-sticky-progress">
              {hasScrubber
                ? `${fmtTime(s.currentTime)} / ${fmtTime(s.duration)} · ${s.chunkIdx + 1}/${s.totalChunks}`
                : `${s.chunkIdx + 1}/${s.totalChunks}`}
            </span>
          )}
        </div>
        <div className="audio-sticky-ctrls">
          <button
            className="audio-ctrl"
            onClick={() => p.skipBack(10)}
            aria-label={t("audioBack10")}
            title={t("audioBack10")}
          >
            −10s
          </button>
          {s.mode === "playing" && s.preparing && (
            <span className="audio-ctrl audio-ctrl-primary prep" title={t("lecturePreparing")}>
              <span className="spinner" />
            </span>
          )}
          {s.mode === "playing" && !s.preparing && (
            <button
              className="audio-ctrl audio-ctrl-primary"
              onClick={p.pause}
              aria-label={t("lecturePause")}
              title={t("lecturePause")}
            >
              ⏸
            </button>
          )}
          {s.mode === "paused" && (
            <button
              className="audio-ctrl audio-ctrl-primary"
              onClick={p.resume}
              aria-label={t("lectureResume")}
              title={t("lectureResume")}
            >
              ▶
            </button>
          )}
          <button
            className="audio-ctrl"
            onClick={() => p.skipForward(10)}
            aria-label={t("audioFwd10")}
            title={t("audioFwd10")}
          >
            +10s
          </button>
          <button
            className="audio-ctrl audio-ctrl-ghost"
            onClick={p.stop}
            aria-label={t("lectureStop")}
            title={t("lectureStop")}
          >
            ✕
          </button>
          <button
            className="audio-ctrl audio-ctrl-ghost"
            onClick={p.toggleExpand}
            aria-label={t("audioExpand")}
            title={t("audioExpand")}
          >
            ⤢
          </button>
        </div>
      </div>
      {hasScrubber && (
        <div className="audio-seek-wrap audio-seek-wrap--mini">
          <div className="audio-seek-track" />
          <div className="audio-seek-fill" style={{ width: `${pct}%` }} />
          <input
            type="range"
            className="audio-seek-input"
            min={0}
            max={s.duration}
            step={0.1}
            value={Math.min(s.currentTime, s.duration)}
            onChange={(e) => p.seekTo(Number(e.target.value))}
            aria-label="seek"
          />
        </div>
      )}
    </div>
  );
}

function ExpandedPlayer() {
  const t = useT();
  const p = useAudioPlayer();
  const s = p.state;
  return (
    <div className="audio-expanded" role="dialog" aria-label={t("audioExpand")}>
      <button
        className="audio-collapse"
        onClick={p.toggleExpand}
        aria-label={t("audioCollapse")}
        title={t("audioCollapse")}
      >
        ×
      </button>
      <div className="audio-expanded-inner">
        <div className="audio-expanded-engine">{s.engine === "gemini" ? "Gemini" : t("ttsSystem")}</div>
        <h2 className="audio-expanded-title">{s.title}</h2>
        {s.totalChunks > 0 && (
          <div className="audio-expanded-progress">
            {t("audioChunk")} {s.chunkIdx + 1} / {s.totalChunks}
          </div>
        )}
        {s.engine === "gemini" && s.duration > 0 && (
          <div className="audio-seekrow">
            <span className="audio-seektime">{fmtTime(s.currentTime)}</span>
            <div className="audio-seek-wrap audio-seek-wrap--big">
              <div className="audio-seek-track" />
              <div
                className="audio-seek-fill"
                style={{ width: `${Math.min(100, (s.currentTime / s.duration) * 100)}%` }}
              />
              <input
                type="range"
                className="audio-seek-input"
                min={0}
                max={s.duration}
                step={0.1}
                value={Math.min(s.currentTime, s.duration)}
                onChange={(e) => p.seekTo(Number(e.target.value))}
                aria-label="seek"
              />
            </div>
            <span className="audio-seektime">{fmtTime(s.duration)}</span>
          </div>
        )}
        <div className="audio-expanded-ctrls">
          {s.mode === "playing" && s.preparing && (
            <div className="audio-expanded-prep">
              <span className="spinner" /> {t("lecturePreparing")}
            </div>
          )}
          <button
            className="audio-big audio-big-skip"
            onClick={() => p.skipBack(10)}
            aria-label={t("audioBack10")}
          >
            −10s
          </button>
          {s.mode === "playing" && !s.preparing && (
            <button className="audio-big audio-big-primary" onClick={p.pause} aria-label={t("lecturePause")}>
              ⏸
            </button>
          )}
          {s.mode === "paused" && (
            <button className="audio-big audio-big-primary" onClick={p.resume} aria-label={t("lectureResume")}>
              ▶
            </button>
          )}
          <button
            className="audio-big audio-big-skip"
            onClick={() => p.skipForward(10)}
            aria-label={t("audioFwd10")}
          >
            +10s
          </button>
          <button className="audio-big audio-big-stop" onClick={p.stop} aria-label={t("lectureStop")}>
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}

// Trigger button shown in the submodule toolbar. When this submodule is what's
// currently playing, the button morphs into inline pause/resume/stop so the
// learner has controls right next to the article too.
function LectureAudio({ article, lang, title }: { article: string; lang: string; title: string }) {
  const t = useT();
  const player = useAudioPlayer();
  const s = player.state;
  const isCurrent = s.mode !== "idle" && s.title === title;

  if (!isCurrent) {
    return (
      <button
        className="lecture-btn"
        onClick={() => player.start(article, title, lang)}
        title={t("lectureListen")}
      >
        ▶ {t("lectureListen")}
      </button>
    );
  }
  return (
    <span className="lecture-audio">
      {s.mode === "playing" && s.preparing && (
        <span className="lecture-btn lecture-prep">
          <span className="spinner" /> {t("lecturePreparing")}
        </span>
      )}
      {s.mode === "playing" && !s.preparing && (
        <button className="lecture-btn" onClick={player.pause} title={t("lecturePause")}>
          ⏸ {t("lecturePause")}
        </button>
      )}
      {s.mode === "paused" && (
        <button className="lecture-btn" onClick={player.resume} title={t("lectureResume")}>
          ▶ {t("lectureResume")}
        </button>
      )}
      <button
        className="lecture-btn lecture-stop"
        onClick={player.stop}
        title={t("lectureStop")}
        aria-label={t("lectureStop")}
      >
        ✕
      </button>
    </span>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const res = String(r.result || "");
      const comma = res.indexOf(",");
      resolve(comma >= 0 ? res.slice(comma + 1) : res);
    };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

const MAX_UPLOAD_MB = 25;
const CRIT_LABEL: Record<Criticality, string> = {
  critical: "critCritical",
  major: "critMajor",
  minor: "critMinor",
};

// Homework chain shown below the article. Loads on mount and reloads when the
// background generation finishes (agent_assignments). Sequential unlock: the
// first not-passed assignment is active, later ones are locked.
function AssignmentsSection({
  courseId,
  moduleId,
  submoduleId,
}: {
  courseId: string;
  moduleId: string;
  submoduleId: string;
}) {
  const t = useT();
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [generating, setGenerating] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await invoke<{ assignments: Assignment[] }>("get_assignments", {
        courseId,
        moduleId,
        submoduleId,
      });
      setAssignments(res.assignments ?? []);
    } catch {
      setAssignments([]);
    }
  }, [courseId, moduleId, submoduleId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const unl = listen<{ courseId: string; submoduleId: string }>("agent_assignments", (e) => {
      if (e.payload.courseId === courseId && e.payload.submoduleId === submoduleId) {
        setGenerating(false);
        load();
      }
    });
    return () => {
      unl.then((f) => f());
    };
  }, [courseId, submoduleId, load]);

  // No chain yet (older submodule, or not generated) — offer to make one.
  if (assignments.length === 0) {
    return (
      <div className="assignments">
        <h2 className="assignments-h">{t("assignmentsTitle")}</h2>
        <button
          className="assignment-send"
          disabled={generating}
          onClick={async () => {
            setGenerating(true);
            try {
              await invoke("start_generate_assignments", { courseId, moduleId, submoduleId });
            } catch {
              setGenerating(false);
            }
          }}
        >
          {generating ? (
            <>
              <span className="spinner" /> {t("assignmentsGenerating")}
            </>
          ) : (
            t("assignmentsGenerate")
          )}
        </button>
      </div>
    );
  }

  const activeIdx = assignments.findIndex((a) => a.status !== "passed");

  return (
    <div className="assignments">
      <h2 className="assignments-h">{t("assignmentsTitle")}</h2>
      {assignments.map((a, i) => (
        <AssignmentCard
          key={a.id}
          assignment={a}
          courseId={courseId}
          moduleId={moduleId}
          submoduleId={submoduleId}
          locked={activeIdx !== -1 && i > activeIdx}
          onReviewed={load}
        />
      ))}
    </div>
  );
}

function AssignmentCard({
  assignment,
  courseId,
  moduleId,
  submoduleId,
  locked,
  onReviewed,
}: {
  assignment: Assignment;
  courseId: string;
  moduleId: string;
  submoduleId: string;
  locked: boolean;
  onReviewed: () => void | Promise<void>;
}) {
  const t = useT();
  const a = assignment;
  const [text, setText] = useState("");
  const [githubUrl, setGithubUrl] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const passed = a.status === "passed";
  const fileType = a.type === "image" || a.type === "document" || a.type === "archive";

  function onPickFiles(e: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    if (picked.some((f) => f.size > MAX_UPLOAD_MB * 1024 * 1024)) {
      setError(t("assignmentTooBig", { mb: String(MAX_UPLOAD_MB) }));
      return;
    }
    setError(null);
    setFiles(picked);
  }

  async function submit() {
    setError(null);
    if (a.type === "text" && !text.trim()) return setError(t("assignmentNeedText"));
    if (a.type === "github" && !githubUrl.trim()) return setError(t("assignmentNeedUrl"));
    if (fileType && files.length === 0) return setError(t("assignmentNeedFile"));
    setBusy(true);
    try {
      const uploads = await Promise.all(
        files.map(async (f) => ({ name: f.name, base64: await fileToBase64(f) }))
      );
      await invoke("submit_assignment", {
        courseId,
        moduleId,
        submoduleId,
        assignmentId: a.id,
        submissionType: a.type,
        text: text.trim() || null,
        githubUrl: githubUrl.trim() || null,
        files: uploads,
      });
      setText("");
      setGithubUrl("");
      setFiles([]);
      await onReviewed();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`assignment${passed ? " passed" : ""}${locked ? " locked" : ""}`}>
      <div className="assignment-head">
        <span className="assignment-status">{passed ? "✓" : locked ? "🔒" : "•"}</span>
        <span className="assignment-title">{a.title}</span>
      </div>
      <div className="assignment-prompt">{a.prompt}</div>
      {a.criteria && (
        <details className="assignment-criteria">
          <summary>{t("assignmentCriteria")}</summary>
          <div>{a.criteria}</div>
        </details>
      )}

      {a.chat.length > 0 && (
        <div className="assignment-chat">
          {a.chat.map((turn, i) => (
            <AssignmentTurnView key={i} turn={turn} />
          ))}
        </div>
      )}

      {locked && <div className="assignment-locked-note">{t("assignmentLocked")}</div>}

      {!passed && !locked && (
        <div className="assignment-submit">
          {a.type === "text" && (
            <textarea
              className="assignment-textarea"
              placeholder={t("assignmentAnswerPlaceholder")}
              value={text}
              onChange={(e) => setText(e.target.value)}
              disabled={busy}
            />
          )}
          {a.type === "github" && (
            <input
              className="assignment-input"
              type="url"
              placeholder="https://github.com/user/repo"
              value={githubUrl}
              onChange={(e) => setGithubUrl(e.target.value)}
              disabled={busy}
            />
          )}
          {fileType && (
            <>
              <input
                className="assignment-file"
                type="file"
                multiple={a.type === "image"}
                accept={a.type === "image" ? "image/*" : a.type === "archive" ? ".zip" : undefined}
                onChange={onPickFiles}
                disabled={busy}
              />
              {files.length > 0 && (
                <div className="assignment-files">
                  {files.map((f, i) => (
                    <span key={i} className="assignment-file-chip">
                      {f.name}
                    </span>
                  ))}
                </div>
              )}
              <textarea
                className="assignment-textarea"
                placeholder={t("assignmentNotePlaceholder")}
                value={text}
                onChange={(e) => setText(e.target.value)}
                disabled={busy}
              />
            </>
          )}
          {error && <div className="assignment-error">{error}</div>}
          <button className="assignment-send" onClick={submit} disabled={busy}>
            {busy ? (
              <>
                <span className="spinner" /> {t("assignmentReviewing")}
              </>
            ) : (
              t("assignmentSend")
            )}
          </button>
        </div>
      )}

      {passed && <div className="assignment-passed-note">{t("assignmentPassed")}</div>}
    </div>
  );
}

function AssignmentTurnView({ turn }: { turn: AssignmentTurn }) {
  const t = useT();
  if (turn.role === "user") {
    return (
      <div className="assignment-bubble user">
        <div className="assignment-bubble-who">{t("assignmentYou")}</div>
        {turn.text && <div className="assignment-bubble-text">{turn.text}</div>}
        {turn.githubUrl && (
          <a className="assignment-bubble-link" href={turn.githubUrl} target="_blank" rel="noreferrer">
            {turn.githubUrl}
          </a>
        )}
        {(turn.files ?? []).map((f, i) =>
          /\.(png|jpe?g|webp|gif)$/i.test(f.name) ? (
            <img key={i} className="assignment-bubble-img" src={convertFileSrc(f.path)} alt={f.name} />
          ) : (
            <span key={i} className="assignment-file-chip">
              {f.name}
            </span>
          )
        )}
      </div>
    );
  }
  return (
    <div className={`assignment-bubble agent ${turn.verdict}`}>
      <div className="assignment-bubble-who">
        {t("assignmentReviewer")} ·{" "}
        {turn.verdict === "passed" ? t("assignmentVerdictPassed") : t("assignmentVerdictRevise")}
      </div>
      {turn.summary && <div className="assignment-bubble-text">{turn.summary}</div>}
      {(turn.remarks ?? []).length > 0 && (
        <ul className="assignment-remarks">
          {turn.remarks.map((r, i) => (
            <li key={i} className={`assignment-remark ${r.criticality}`}>
              <span className="crit-badge">{t(CRIT_LABEL[r.criticality] as any)}</span> {r.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const STAGE_ORDER: StageName[] = ["draft", "annotate", "illustrate", "test"];

const TEST_PASS_THRESHOLD = 0.7;

const ACT_KEYS: Record<string, string> = {
  thinking: "actThinking",
  writing: "actWriting",
  searching: "actSearching",
  reading: "actReading",
  reviewing: "actReviewing",
  marking: "actMarking",
  validating: "actValidating",
  downloading: "actDownloading",
  running: "actRunning",
};

const KIND_ICON: Record<string, string> = {
  thinking: "🤔",
  writing: "✍️",
  searching: "🔍",
  reading: "📄",
  "searching images": "🖼️",
  reviewing: "🔎",
  marking: "🏷️",
  validating: "✅",
  downloading: "⬇️",
  running: "⚙️",
};

const STAGE_LABEL_KEYS: Record<string, string> = {
  draft: "stageDraft",
  annotate: "stageAnnotate",
  illustrate: "stageIllustrate",
  test: "stageTest",
};

// Live feed of agent activity during generation, rendered as chat bubbles.
function AgentTranscript({ transcript }: { transcript: Bubble[] | null }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcript]);
  if (!transcript || transcript.length === 0) return null;
  return (
    <div className="agent-transcript" ref={ref}>
      {transcript.map((b, i) => {
        if (b.kind === "stage") {
          const key = STAGE_LABEL_KEYS[b.text];
          return (
            <div key={i} className="bubble-stage">
              {key ? t(key as any) : b.text}
            </div>
          );
        }
        const labelKey = ACT_KEYS[b.kind];
        const verb = labelKey ? t(labelKey as any) : b.kind;
        const icon = KIND_ICON[b.kind] ?? "•";
        return (
          <div key={i} className="agent-bubble">
            <div className="bubble-kind">
              {icon} {verb}
            </div>
            {b.text && <div className="bubble-text">{b.text}</div>}
          </div>
        );
      })}
    </div>
  );
}

function LiveActivity({ stageDetail }: { stageDetail: StageDetail | null }) {
  const t = useT();
  if (!stageDetail) {
    return (
      <div className="sub-generating-label">
        <span className="spinner" /> {t("stageRunning")}
      </div>
    );
  }
  const labelKey = stageDetail.label ? ACT_KEYS[stageDetail.label] : null;
  const verb = labelKey ? t(labelKey as any) : stageDetail.label;
  return (
    <div className="live-activity">
      <div className="sub-generating-label">
        <span className="spinner" />{" "}
        {verb ? (
          <>
            {t("stageRunning")} <span className="verb">·&nbsp;{verb}</span>
          </>
        ) : (
          t("stageRunning")
        )}
      </div>
      {stageDetail.detail && (
        <div className="live-detail" title={stageDetail.detail}>
          {stageDetail.detail}
        </div>
      )}
    </div>
  );
}

function StageStrip({ current }: { current: StageName }) {
  const t = useT();
  const idx = STAGE_ORDER.indexOf(current);
  const labels: Record<StageName, string> = {
    draft: t("stageDraft"),
    annotate: t("stageAnnotate"),
    illustrate: t("stageIllustrate"),
    test: t("stageTest"),
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
  fontPx,
}: {
  article: string;
  widgets: Record<string, WidgetData>;
  fontPx: number;
}) {
  const parts = splitWidgetMarkers(article);
  return (
    <article className="reader" style={{ ["--reader-font" as string]: `${fontPx}px` }}>
      {parts.map((p, i) =>
        p.kind === "md" ? (
          <ReactMarkdown
            key={i}
            remarkPlugins={[remarkGfm, remarkMath]}
            rehypePlugins={[rehypeKatex]}
          >
            {p.text}
          </ReactMarkdown>
        ) : (
          <WidgetRenderer key={i} id={p.id} widget={widgets[p.id]} />
        )
      )}
    </article>
  );
}

function WidgetRenderer({ id, widget }: { id: string; widget?: WidgetData }) {
  const t = useT();
  if (!widget) {
    return (
      <div className="widget widget-unknown">
        {t("widgetUnknown")} <span className="widget-id">#{id}</span>
      </div>
    );
  }
  if (widget.type === "image") return <ImagePlaceholder id={id} widget={widget as any} />;
  if (widget.type === "diagram") return <DiagramWidget id={id} widget={widget as any} />;
  if (widget.type === "video") return <VideoWidget id={id} widget={widget as any} />;
  if (widget.type === "interactive") return <InteractiveWidget id={id} widget={widget as any} />;
  return (
    <div className="widget widget-unknown">
      {t("widgetUnknown")}: {widget.type} <span className="widget-id">#{id}</span>
    </div>
  );
}

function videoEmbedUrl(url: string): string | null {
  try {
    const u = new URL(url);
    // YouTube
    if (u.hostname.includes("youtube.com")) {
      const v = u.searchParams.get("v");
      if (v) return `https://www.youtube.com/embed/${v}`;
      // youtube.com/shorts/ID
      const m = u.pathname.match(/^\/(?:shorts|embed)\/([^/]+)/);
      if (m) return `https://www.youtube.com/embed/${m[1]}`;
    }
    if (u.hostname === "youtu.be") {
      const id = u.pathname.replace(/^\//, "").split("/")[0];
      if (id) return `https://www.youtube.com/embed/${id}`;
    }
    // Vimeo
    if (u.hostname.includes("vimeo.com")) {
      const id = u.pathname.replace(/^\//, "").split("/")[0];
      if (/^\d+$/.test(id)) return `https://player.vimeo.com/video/${id}`;
    }
    return null;
  } catch {
    return null;
  }
}

function VideoWidget({
  id,
  widget,
}: {
  id: string;
  widget: { url: string; title?: string; recommended_by?: string; why?: string };
}) {
  const t = useT();
  const embed = videoEmbedUrl(widget.url);
  return (
    <figure className="widget widget-video">
      {embed ? (
        <div className="widget-video-frame">
          <iframe
            src={embed}
            title={widget.title || `video ${id}`}
            allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
          />
        </div>
      ) : (
        <a
          className="widget-video-fallback"
          href={widget.url}
          target="_blank"
          rel="noreferrer"
        >
          {widget.title || t("widgetVideoOpen")} →
        </a>
      )}
      <figcaption>
        {widget.title && <div className="widget-video-title">{widget.title}</div>}
        {widget.why && <div className="widget-video-why">{widget.why}</div>}
        {widget.recommended_by && (
          <div className="widget-video-rec">
            {t("widgetVideoRecommended")}{" "}
            <a href={widget.recommended_by} target="_blank" rel="noreferrer">
              {hostnameOf(widget.recommended_by)}
            </a>
          </div>
        )}
      </figcaption>
    </figure>
  );
}

function hostnameOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function TestSection({
  questions,
  alreadyPassed,
  onPassed,
}: {
  questions: TestQuestion[];
  alreadyPassed: boolean;
  onPassed: () => void | Promise<void>;
}) {
  const t = useT();
  const [started, setStarted] = useState(false);
  const [answers, setAnswers] = useState<(number | null)[]>(
    questions.map(() => null)
  );
  const [submitted, setSubmitted] = useState(false);

  const correctCount = questions.reduce(
    (n, q, i) => (answers[i] === q.correct ? n + 1 : n),
    0
  );
  const ratio = questions.length > 0 ? correctCount / questions.length : 0;
  const passed = ratio >= TEST_PASS_THRESHOLD;
  const allAnswered = answers.every((a) => a !== null);

  async function submit() {
    setSubmitted(true);
    if (ratio >= TEST_PASS_THRESHOLD) {
      await onPassed();
    }
  }

  function retake() {
    setAnswers(questions.map(() => null));
    setSubmitted(false);
  }

  if (!started) {
    return (
      <section className="test">
        <div className="test-header">
          <h3 className="test-title">{t("testTitle")}</h3>
          {alreadyPassed && <span className="learned-badge">✓ {t("subLearned")}</span>}
        </div>
        <button className="test-start" onClick={() => setStarted(true)}>
          {alreadyPassed ? t("testRetake") : t("testStart")}
        </button>
      </section>
    );
  }

  return (
    <section className="test">
      <div className="test-header">
        <h3 className="test-title">{t("testTitle")}</h3>
      </div>
      <ol className="test-questions">
        {questions.map((q, i) => (
          <li key={i} className="test-q">
            <div className="test-q-text">{q.text}</div>
            <div className="test-options">
              {q.options.map((opt, j) => {
                const chosen = answers[i] === j;
                let cls = "test-option";
                if (submitted) {
                  if (j === q.correct) cls += " correct";
                  else if (chosen) cls += " wrong";
                } else if (chosen) {
                  cls += " chosen";
                }
                return (
                  <label key={j} className={cls}>
                    <input
                      type="radio"
                      name={`tq-${i}`}
                      checked={chosen}
                      disabled={submitted}
                      onChange={() =>
                        setAnswers((prev) =>
                          prev.map((a, k) => (k === i ? j : a))
                        )
                      }
                    />
                    <span>{opt}</span>
                  </label>
                );
              })}
            </div>
            {submitted && q.explanation && (
              <div className="test-explanation">{q.explanation}</div>
            )}
          </li>
        ))}
      </ol>

      {!submitted ? (
        <button className="test-start" onClick={submit} disabled={!allAnswered}>
          {t("testSubmit")}
        </button>
      ) : (
        <div className={`test-result ${passed ? "pass" : "fail"}`}>
          <div className="test-result-score">
            {t("testScore", { correct: correctCount, total: questions.length })}
          </div>
          <div className="test-result-verdict">
            {passed
              ? `✓ ${t("testPassed")}`
              : t("testFailed", { threshold: Math.round(TEST_PASS_THRESHOLD * 100) })}
          </div>
          <button className="test-start ghost" onClick={retake}>
            {t("testRetake")}
          </button>
        </div>
      )}
    </section>
  );
}

function SourcesList({ sources }: { sources: Source[] }) {
  const t = useT();
  return (
    <section className="sources">
      <h3 className="sources-title">{t("sourcesTitle")}</h3>
      <ol className="sources-list">
        {sources.map((s, i) => (
          <li key={i}>
            <a href={s.url} target="_blank" rel="noreferrer">
              {s.title || s.url}
            </a>
            <span className="sources-host">{hostnameOf(s.url)}</span>
          </li>
        ))}
      </ol>
    </section>
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

function InteractiveWidget({
  id,
  widget,
}: {
  id: string;
  widget: {
    title?: string;
    description?: string;
    html: string;
    css: string;
    js: string;
    height?: number;
    error?: string;
  };
}) {
  const t = useT();
  if (widget.error) {
    return (
      <figure className="widget widget-interactive widget-interactive-broken">
        <div className="widget-interactive-error-label">
          {t("widgetInteractiveBroken")} <span className="widget-id">#{id}</span>
        </div>
        {widget.title && <div className="widget-interactive-title">{widget.title}</div>}
        {widget.description && (
          <div className="widget-interactive-desc">{widget.description}</div>
        )}
        <pre className="widget-interactive-error-msg">{widget.error}</pre>
        <details>
          <summary>{t("widgetInteractiveShowSource")}</summary>
          <pre className="widget-interactive-source">
            {`<!-- html -->\n${widget.html}\n\n/* css */\n${widget.css}\n\n// js\n${widget.js}`}
          </pre>
        </details>
      </figure>
    );
  }
  const height = Math.max(160, Math.min(640, Math.round(widget.height ?? 320)));
  const doc = buildInteractiveDoc(widget.html, widget.css, widget.js);
  return (
    <figure className="widget widget-interactive">
      <div className="widget-interactive-header">
        <span className="widget-interactive-tag">{t("widgetInteractive")}</span>
        {widget.title && (
          <span className="widget-interactive-title">{widget.title}</span>
        )}
      </div>
      <iframe
        className="widget-interactive-frame"
        sandbox="allow-scripts"
        srcDoc={doc}
        title={widget.title || `interactive ${id}`}
        style={{ height }}
      />
      {widget.description && (
        <figcaption className="widget-interactive-desc">{widget.description}</figcaption>
      )}
    </figure>
  );
}

function buildInteractiveDoc(html: string, css: string, js: string): string {
  // CSP blocks every external resource; only inline scripts/styles allowed.
  // The outer iframe sandbox already disables same-origin / parent access.
  const csp =
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:;";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>
:root{color-scheme:light dark}
body{margin:0;padding:14px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;font-size:14px;line-height:1.5;color:#1c1917;background:#fafaf9}
@media (prefers-color-scheme: dark){body{background:#1c1917;color:#fafaf9}}
${css}
</style></head><body>${html}<script>${js}</script></body></html>`;
}

function ImagePlaceholder({
  id,
  widget,
}: {
  id: string;
  widget: {
    description?: string;
    alt?: string;
    url?: string;
    source?: string;
    generated?: boolean;
  };
}) {
  const t = useT();
  const hasUrl = typeof widget.url === "string" && widget.url.length > 0;
  // Local files (absolute paths or file://) need the tauri asset protocol.
  // Anything else (https://...) is rendered as-is.
  const isLocal =
    hasUrl && (widget.url!.startsWith("/") || widget.url!.startsWith("file://"));
  const imgSrc = !hasUrl
    ? ""
    : isLocal
      ? convertFileSrc(widget.url!.replace(/^file:\/\//, ""))
      : widget.url!;
  const linkHref = widget.source || (isLocal ? imgSrc : widget.url);
  return (
    <figure className="widget widget-image">
      {hasUrl ? (
        <a
          href={linkHref}
          target="_blank"
          rel="noreferrer"
          className="widget-image-link"
        >
          <img src={imgSrc} alt={widget.alt || ""} className="widget-image-real" />
        </a>
      ) : (
        <div className="widget-image-box">
          <span className="widget-label">{t("widgetImage")}</span>
          <span className="widget-id">#{id}</span>
        </div>
      )}
      {(widget?.description || widget?.alt || widget?.generated) && (
        <figcaption>
          {widget.description}
          {widget.alt && (
            <span className="widget-alt">
              {" "}
              · {t("widgetImageAlt")} {widget.alt}
            </span>
          )}
          {widget.generated && (
            <span className="widget-generated"> · 🪄 {t("imgGenerated")}</span>
          )}
        </figcaption>
      )}
    </figure>
  );
}

function DiagramWidget({
  id,
  widget,
}: {
  id: string;
  widget: { source: string; caption?: string; error?: string };
}) {
  const t = useT();
  const [svg, setSvg] = useState<string | null>(null);
  const [renderError, setRenderError] = useState<string | null>(widget.error ?? null);
  const [zoomed, setZoomed] = useState(false);
  const [scale, setScale] = useState(1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scaleRef = useRef(1);
  scaleRef.current = scale;
  const pinchRef = useRef<{ dist: number; scale: number } | null>(null);

  useEffect(() => {
    if (widget.error) {
      setRenderError(widget.error);
      return;
    }
    let cancelled = false;
    setRenderError(null);
    (async () => {
      try {
        const mermaidMod = await import("mermaid");
        const mermaid = mermaidMod.default;
        mermaid.initialize({
          startOnLoad: false,
          theme:
            window.matchMedia &&
            window.matchMedia("(prefers-color-scheme: dark)").matches
              ? "dark"
              : "default",
          securityLevel: "loose",
        });
        const renderId = `mermaid-${id}-${Math.random().toString(36).slice(2, 8)}`;
        const { svg } = await mermaid.render(renderId, widget.source);
        if (!cancelled) setSvg(svg);
      } catch (e: any) {
        if (!cancelled) setRenderError(String(e?.message ?? e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [widget.source, widget.error, id]);

  useEffect(() => {
    if (!zoomed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setZoomed(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomed]);

  // Pinch-to-zoom on touch devices. One finger pans (native scroll); two
  // fingers scale the diagram.
  useEffect(() => {
    if (!zoomed) return;
    const el = scrollRef.current;
    if (!el) return;
    const dist = (t: TouchList) =>
      Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const onStart = (e: TouchEvent) => {
      if (e.touches.length === 2)
        pinchRef.current = { dist: dist(e.touches), scale: scaleRef.current };
    };
    const onMove = (e: TouchEvent) => {
      if (e.touches.length === 2 && pinchRef.current) {
        e.preventDefault();
        const ratio = dist(e.touches) / pinchRef.current.dist;
        setScale(Math.max(0.5, Math.min(6, +(pinchRef.current.scale * ratio).toFixed(3))));
      }
    };
    const onEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) pinchRef.current = null;
    };
    el.addEventListener("touchstart", onStart, { passive: false });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
    };
  }, [zoomed]);

  return (
    <figure className="widget widget-diagram">
      {renderError ? (
        <div className="widget-diagram-error">
          <div className="widget-diagram-error-label">
            {t("widgetDiagramError")} <span className="widget-id">#{id}</span>
          </div>
          <pre className="widget-diagram-error-msg">{renderError}</pre>
          <details>
            <summary>source</summary>
            <pre className="widget-diagram-source">{widget.source}</pre>
          </details>
        </div>
      ) : (
        <div
          className="widget-diagram-box"
          role="button"
          tabIndex={0}
          title={t("diagramZoom")}
          onClick={() => {
            if (svg) {
              setScale(1);
              setZoomed(true);
            }
          }}
          dangerouslySetInnerHTML={{ __html: svg ?? "" }}
        />
      )}
      {widget.caption && <figcaption>{widget.caption}</figcaption>}
      {zoomed && svg && (
        <div className="diagram-zoom" onClick={() => setZoomed(false)}>
          <div className="diagram-zoom-bar" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setScale((s) => Math.max(0.5, +(s - 0.25).toFixed(2)))}>
              −
            </button>
            <button onClick={() => setScale(1)}>{Math.round(scale * 100)}%</button>
            <button onClick={() => setScale((s) => Math.min(6, +(s + 0.25).toFixed(2)))}>
              +
            </button>
            <button onClick={() => setZoomed(false)} aria-label="close">
              ✕
            </button>
          </div>
          <div
            className="diagram-zoom-scroll"
            ref={scrollRef}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="diagram-zoom-svg"
              style={{ transform: `scale(${scale})` }}
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          </div>
        </div>
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

export default App;

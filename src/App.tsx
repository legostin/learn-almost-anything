import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import hljs from "highlight.js";
import { mermaidGrammar } from "./mermaid-grammar";
import "katex/dist/katex.min.css";
import "highlight.js/styles/github.css";

// highlight.js ships no Mermaid grammar — register a vendored, well-tested one
// so the diagram "code" view gets real syntax highlighting. Guarded so
// hot-reload doesn't re-register.
if (!hljs.getLanguage("mermaid")) {
  hljs.registerLanguage("mermaid", mermaidGrammar);
}
import QRCode from "qrcode";
import { relaunch } from "@tauri-apps/plugin-process";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { convertFileSrc, invoke, listen, isTauri } from "./transport";
import { useLang, useT, type Lang } from "./i18n";
import appLoader from "./assets/app-loader.gif";
import appMark from "./assets/app-mark.png";
import "./App.css";

type Agent = "claude" | "codex";
type CourseFormat = "academic_course" | "mini_module" | "podcast_series";

const DEFAULT_COURSE_FORMAT: CourseFormat = "academic_course";

const COURSE_FORMATS = [
  {
    value: "academic_course",
    titleKey: "courseFormatAcademicTitle",
    descKey: "courseFormatAcademicDesc",
  },
  {
    value: "mini_module",
    titleKey: "courseFormatMiniTitle",
    descKey: "courseFormatMiniDesc",
  },
  {
    value: "podcast_series",
    titleKey: "courseFormatPodcastTitle",
    descKey: "courseFormatPodcastDesc",
  },
] as const satisfies ReadonlyArray<{
  value: CourseFormat;
  titleKey:
    | "courseFormatAcademicTitle"
    | "courseFormatMiniTitle"
    | "courseFormatPodcastTitle";
  descKey:
    | "courseFormatAcademicDesc"
    | "courseFormatMiniDesc"
    | "courseFormatPodcastDesc";
}>;

type Course = {
  id: string;
  topic: string;
  title?: string | null;
  language: string;
  course_format: CourseFormat;
  status: string;
  agent: Agent;
  created_at: number;
  updated_at: number;
  catalog_origin_id?: string | null;
  catalog_version?: number;
  catalog_synced_at?: number | null;
  space_id?: string | null;
  translated_from?: string | null;
  category?: string | null;
};

// Localized labels for the agent-assigned subject category. Keep the id set in
// sync with sidecar/src/lib/categories.mjs and db.rs normalize_category.
const CATEGORY_LABELS: Record<string, Record<Lang, string>> = {
  programming: { en: "Programming", ru: "Программирование" },
  data_ai: { en: "Data & AI", ru: "Данные и ИИ" },
  science_math: { en: "Science & Math", ru: "Наука и математика" },
  engineering: { en: "Engineering", ru: "Инженерия" },
  business: { en: "Business & Finance", ru: "Бизнес и финансы" },
  humanities: { en: "History & Humanities", ru: "История и гуманитарные" },
  social_science: { en: "Social Sciences", ru: "Социальные науки" },
  arts_design: { en: "Arts & Design", ru: "Искусство и дизайн" },
  music: { en: "Music", ru: "Музыка" },
  language: { en: "Languages", ru: "Языки" },
  health: { en: "Health & Medicine", ru: "Здоровье и медицина" },
  lifestyle: { en: "Lifestyle & Skills", ru: "Быт и навыки" },
  general: { en: "General", ru: "Общее" },
};

function categoryLabel(cat: string | null | undefined, lang: Lang): string | null {
  if (!cat) return null;
  return CATEGORY_LABELS[cat]?.[lang] ?? null;
}

type CatalogCourse = {
  id: string;
  origin_id?: string;
  title: string;
  topic: string;
  language: string;
  course_format?: CourseFormat;
  updated_at: number;
  version?: number;
  modules: number;
  lessons: number;
  generated_lessons: number;
  tags?: string[];
  topics?: string[];
  view_url: string;
  download_url: string;
};

type CatalogUpdateStatus = {
  course_id: string;
  catalog_id: string | null;
  local_version: number;
  remote_version: number | null;
  local_generated_lessons: number;
  remote_generated_lessons: number | null;
  available: boolean;
};

type AppUpdatePhase =
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "downloading"
  | "restarting"
  | "error";

type AppUpdateInfo = {
  version: string;
  currentVersion: string;
  body?: string;
  date?: string;
};

function courseTitle(course: Course, fallback: string) {
  if (course.title === undefined) return course.topic || fallback;
  return course.title?.trim() || fallback;
}

type Question = { text: string; options: string[]; multi?: boolean };

type GenState = "pending" | "queued" | "generating" | "ready" | "failed";

type ModuleNode = {
  id: string;
  title: string;
  summary: string;
  generation_state: GenState;
  test_passed?: boolean;
  test_passed_at?: number | null;
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

type JobKind = "wizard_questions" | "build_structure" | "generate_submodule" | "translate";

type JobState =
  | { kind: JobKind; status: "running" }
  | { kind: JobKind; status: "done"; result?: unknown }
  | { kind: JobKind; status: "error"; error: string; exhausted?: boolean; agent?: string };

type JobEvent = {
  courseId: string;
  kind: JobKind;
  ok: boolean;
  result?: unknown;
  error?: string;
};

type CourseSuggestionEvent = {
  ok: boolean;
  topic?: string;
  title?: string;
  reason?: string;
  agent?: Agent;
  language?: string;
  error?: string;
};

type SuggestedCourseIdea = {
  topic: string;
  title: string;
  reason?: string;
  agent: Agent;
  language: string;
};

type CourseSuggestionState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "ready"; idea: SuggestedCourseIdea }
  | { status: "error"; error: string };

type View =
  | { kind: "empty" }
  | { kind: "creating"; spaceId?: string }
  | { kind: "catalog" }
  | { kind: "spaces" }
  | { kind: "space"; id: string }
  | { kind: "course"; id: string }
  | { kind: "submodule"; courseId: string; moduleId: string; submoduleId: string };

type Space = {
  id: string;
  name: string;
  description: string;
  created_at: number;
  updated_at: number;
  strict: boolean;
  source_count: number;
};

type SpaceSource = {
  id: string;
  space_id: string;
  kind: string;
  title: string;
  ref: string;
  status: string;
  md_path?: string | null;
  error?: string | null;
  created_at: number;
};

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
type AgentAvailability = { claude: boolean; codex: boolean };
type ModelInfoLite = {
  value: string;
  label: string;
  description?: string;
  effortLevels: string[];
};
type McpServerStatus = {
  id: string;
  name: string;
  enabled_for: string[];
  tools: string[];
  source: string;
};
type SettingsStatus = {
  brave_configured: boolean;
  gemini_configured: boolean;
  catalog_upload_token_configured?: boolean;
  mcp_servers?: McpServerStatus[];
  tts_engine: string;
  tts_voice: string;
  gemini_image_model: string;
  gemini_tts_model: string;
  debug_logging?: boolean;
  image_generation?: boolean;
};
type Tagline = { ru: string; en: string };

const HOME_TAGLINES: Tagline[] = [
  {
    ru: "Учёба превращает любопытство в навык, а навык — в свободу действовать.",
    en: "Learning turns curiosity into skill, and skill into freedom to act.",
  },
  {
    ru: "Каждый хороший вопрос сокращает путь между незнанием и делом.",
    en: "Every good question shortens the path between not knowing and doing.",
  },
  {
    ru: "Знание становится вашим только после практики, ошибки и повторения.",
    en: "Knowledge becomes yours only after practice, mistakes and repetition.",
  },
  {
    ru: "Учиться — значит каждый день чуть точнее видеть мир.",
    en: "To learn is to see the world a little more clearly every day.",
  },
  {
    ru: "Сложная тема сдаётся не силе воли, а маленьким регулярным шагам.",
    en: "A hard topic yields not to willpower, but to small regular steps.",
  },
  {
    ru: "Курс полезен, когда после него проще думать, выбирать и делать.",
    en: "A course is useful when it makes thinking, choosing and doing easier.",
  },
  {
    ru: "Век живи — век учись; особенно когда знания сразу переходят в дело.",
    en: "Keep learning for life, especially when knowledge moves straight into action.",
  },
  {
    ru: "Сенека напоминал: пока живёшь, учись жить.",
    en: "Seneca reminds us: while you live, keep learning how to live.",
  },
  {
    ru: "Сократовское «я знаю, что ничего не знаю» — хорошее начало любого курса.",
    en: "The Socratic “I know that I know nothing” is a good start for any course.",
  },
  {
    ru: "Фрэнсис Бэкон говорил коротко: знание — сила. Практика делает её вашей.",
    en: "Francis Bacon put it shortly: knowledge is power. Practice makes it yours.",
  },
  {
    ru: "Конфуций ценил учёбу с повторением: понимание крепнет, когда к нему возвращаются.",
    en: "Confucius valued learning with review: understanding grows when you return to it.",
  },
  {
    ru: "Марк Аврелий искал ясность в ежедневных заметках; обучение начинается так же.",
    en: "Marcus Aurelius sought clarity in daily notes; learning begins the same way.",
  },
  {
    ru: "Леонардо видел в учёбе бесконечный источник энергии для дела.",
    en: "Leonardo saw learning as an endless source of energy for work.",
  },
  {
    ru: "Монтень учил пробовать мысль на себе: хороший курс делает именно это.",
    en: "Montaigne tested ideas on himself; a good course does the same.",
  },
  {
    ru: "Книга даёт маршрут, но понимание появляется на ваших остановках.",
    en: "A book gives the route, but understanding appears at your own stops.",
  },
  {
    ru: "Глава за главой, задача за задачей — и тема перестаёт быть чужой.",
    en: "Chapter by chapter, exercise by exercise, the topic stops being foreign.",
  },
  {
    ru: "Учебник открывает дверь; ваши вопросы решают, насколько далеко вы зайдёте.",
    en: "A textbook opens the door; your questions decide how far you go.",
  },
  {
    ru: "Хорошая лекция не заменяет мышление, а запускает его.",
    en: "A good lecture does not replace thinking; it starts it.",
  },
  {
    ru: "Читать полезно, когда после чтения меняется способ действовать.",
    en: "Reading is useful when it changes how you act afterward.",
  },
  {
    ru: "Настоящее понимание обычно начинается после первого «не получилось».",
    en: "Real understanding often begins after the first “that did not work.”",
  },
  {
    ru: "Память любит ритм: немного сегодня, немного завтра, снова через неделю.",
    en: "Memory likes rhythm: a little today, a little tomorrow, again next week.",
  },
  {
    ru: "Каждый модуль должен оставлять след: идею, упражнение или новый вопрос.",
    en: "Every module should leave a mark: an idea, an exercise or a new question.",
  },
  {
    ru: "Обучение работает лучше, когда материал спорит с вашей привычной картиной мира.",
    en: "Learning works better when the material challenges your usual picture of the world.",
  },
  {
    ru: "Полезный курс собирает не факты в кучу, а порядок в голове.",
    en: "A useful course does not pile up facts; it creates order in the mind.",
  },
  {
    ru: "Тема становится вашей, когда вы можете объяснить её без шпаргалки.",
    en: "A topic becomes yours when you can explain it without notes.",
  },
  {
    ru: "Лучший конспект — тот, который завтра поможет решить задачу.",
    en: "The best notes are the ones that help solve a problem tomorrow.",
  },
  {
    ru: "Навык растёт там, где есть обратная связь, повторение и честная ошибка.",
    en: "Skill grows where there is feedback, repetition and an honest mistake.",
  },
  {
    ru: "Не нужно знать всё сразу; нужно знать следующий понятный шаг.",
    en: "You do not need to know everything at once; you need the next clear step.",
  },
  {
    ru: "Любая сложная область становится картой, если отмечать на ней пройденные места.",
    en: "Any complex field becomes a map when you mark the places already crossed.",
  },
  {
    ru: "Учёба — это тихий способ увеличить будущие варианты выбора.",
    en: "Learning is a quiet way to increase your future choices.",
  },
  {
    ru: "Когда знания связаны с задачей, мотивация перестаёт быть отдельной проблемой.",
    en: "When knowledge is tied to a task, motivation stops being a separate problem.",
  },
  {
    ru: "Хорошее обучение не обещает лёгкость; оно делает сложность управляемой.",
    en: "Good learning does not promise ease; it makes complexity manageable.",
  },
  {
    ru: "Сегодняшний вопрос часто становится завтрашним инструментом.",
    en: "Today’s question often becomes tomorrow’s tool.",
  },
  {
    ru: "Понимание любит структуру: сначала карта, потом дорога, потом скорость.",
    en: "Understanding likes structure: first the map, then the road, then speed.",
  },
  {
    ru: "Каждый завершённый урок — маленькое доказательство, что тема поддаётся.",
    en: "Every finished lesson is small proof that the topic can be mastered.",
  },
  {
    ru: "Учиться полезно не ради галочки, а ради новой степени свободы.",
    en: "Learning matters not for a checkmark, but for a new degree of freedom.",
  },
];

const HOME_TITLE_FONT_CLASSES = [
  "home-title-font-serif",
  "home-title-font-humanist",
  "home-title-font-condensed",
  "home-title-font-mono",
  "home-title-font-display",
  "home-title-font-hand",
];
const HOME_TITLE_WEIGHT_CLASSES = [
  "home-title-weight-400",
  "home-title-weight-600",
  "home-title-weight-700",
  "home-title-weight-800",
  "home-title-weight-900",
];
const HOME_TITLE_SLANT_CLASSES = ["home-title-slant-normal", "home-title-slant-italic"];

type HomeTitleTextStyles = {
  main: string;
  almost: string;
};

const jobKey = (courseId: string, kind: JobKind) => `${courseId}:${kind}`;

const COURSE_LANGUAGE_STORAGE_KEY = "learnAnything.courseLanguage";
const RECENT_COURSES_STORAGE_KEY = "learnAnything.recentCourses";
const COURSE_LANGUAGES = [
  { code: "en", nameEn: "English", nameRu: "Английский", nativeName: "English" },
  { code: "zh", nameEn: "Chinese", nameRu: "Китайский", nativeName: "中文" },
  { code: "hi", nameEn: "Hindi", nameRu: "Хинди", nativeName: "हिन्दी" },
  { code: "es", nameEn: "Spanish", nameRu: "Испанский", nativeName: "Español" },
  { code: "fr", nameEn: "French", nameRu: "Французский", nativeName: "Français" },
  { code: "ar", nameEn: "Arabic", nameRu: "Арабский", nativeName: "العربية" },
  { code: "bn", nameEn: "Bengali", nameRu: "Бенгальский", nativeName: "বাংলা" },
  { code: "pt", nameEn: "Portuguese", nameRu: "Португальский", nativeName: "Português" },
  { code: "ru", nameEn: "Russian", nameRu: "Русский", nativeName: "Русский" },
  { code: "ur", nameEn: "Urdu", nameRu: "Урду", nativeName: "اردو" },
  { code: "id", nameEn: "Indonesian", nameRu: "Индонезийский", nativeName: "Indonesia" },
  { code: "de", nameEn: "German", nameRu: "Немецкий", nativeName: "Deutsch" },
  { code: "ja", nameEn: "Japanese", nameRu: "Японский", nativeName: "日本語" },
  { code: "pcm", nameEn: "Nigerian Pidgin", nameRu: "Нигерийский пиджин", nativeName: "Naija" },
  { code: "mr", nameEn: "Marathi", nameRu: "Маратхи", nativeName: "मराठी" },
  { code: "te", nameEn: "Telugu", nameRu: "Телугу", nativeName: "తెలుగు" },
  { code: "tr", nameEn: "Turkish", nameRu: "Турецкий", nativeName: "Türkçe" },
  { code: "ta", nameEn: "Tamil", nameRu: "Тамильский", nativeName: "தமிழ்" },
  { code: "vi", nameEn: "Vietnamese", nameRu: "Вьетнамский", nativeName: "Tiếng Việt" },
  { code: "ko", nameEn: "Korean", nameRu: "Корейский", nativeName: "한국어" },
] as const;

function normalizeCourseLanguage(value: string | null | undefined) {
  const code = (value || "").trim().toLowerCase().split("-")[0];
  return COURSE_LANGUAGES.some((language) => language.code === code) ? code : null;
}

function initialCourseLanguage() {
  return (
    normalizeCourseLanguage(localStorage.getItem(COURSE_LANGUAGE_STORAGE_KEY)) ||
    normalizeCourseLanguage(navigator.language) ||
    "en"
  );
}

function courseLanguageLabel(code: string, uiLang: Lang) {
  const normalized = code.trim().toLowerCase();
  const language = COURSE_LANGUAGES.find((item) => item.code === normalized);
  if (!language) return normalized ? normalized.toUpperCase() : "—";
  return uiLang === "ru" ? language.nameRu : language.nameEn;
}

function getCourseLanguageOptions(courses: Course[]) {
  const counts = new Map<string, number>();
  for (const course of courses) {
    const code = (course.language || "").trim().toLowerCase() || "unknown";
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort(([a], [b]) => {
      const rankA = COURSE_LANGUAGES.findIndex((item) => item.code === a);
      const rankB = COURSE_LANGUAGES.findIndex((item) => item.code === b);
      const safeA = rankA === -1 ? Number.MAX_SAFE_INTEGER : rankA;
      const safeB = rankB === -1 ? Number.MAX_SAFE_INTEGER : rankB;
      return safeA - safeB || a.localeCompare(b);
    })
    .map(([code, count]) => ({ code, count }));
}

type CourseProgress = {
  total: number;
  ready: number;
  verified: number;
  verifiedAt: number[];
  pending: number;
  queued: number;
  generating: number;
  failed: number;
  reviewDue: number;
  nextPending?: CoursePointer;
  nextReady?: CoursePointer;
};

type CoursePointer = {
  moduleId: string;
  submoduleId: string;
  index: number;
  title: string;
};

function emptyProgress(): CourseProgress {
  return {
    total: 0,
    ready: 0,
    verified: 0,
    verifiedAt: [],
    pending: 0,
    queued: 0,
    generating: 0,
    failed: 0,
    reviewDue: 0,
  };
}

function summarizeStructure(tree: StructureFile): CourseProgress {
  const progress = emptyProgress();
  for (const module of tree.modules) {
    for (const submodule of module.submodules) {
      progress.total += 1;
      const pointer = {
        moduleId: module.id,
        submoduleId: submodule.id,
        index: progress.total,
        title: submodule.title,
      };
      if (submodule.generation_state === "ready") {
        progress.ready += 1;
        if (!submodule.test_passed && !progress.nextReady) {
          progress.nextReady = pointer;
        }
      } else if (submodule.generation_state === "pending") {
        progress.pending += 1;
        if (!progress.nextPending) {
          progress.nextPending = pointer;
        }
      } else if (submodule.generation_state === "queued") {
        progress.queued += 1;
      } else if (submodule.generation_state === "generating") {
        progress.generating += 1;
      } else if (submodule.generation_state === "failed") {
        progress.failed += 1;
      }
      if (submodule.test_passed) {
        progress.verified += 1;
        if (submodule.test_passed_at) progress.verifiedAt.push(submodule.test_passed_at);
      }
    }
  }
  return progress;
}

function updateInfo(update: Update): AppUpdateInfo {
  return {
    version: update.version,
    currentVersion: update.currentVersion,
    body: update.body,
    date: update.date,
  };
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function useAppUpdater(autoCheck = false) {
  const [phase, setPhase] = useState<AppUpdatePhase>("idle");
  const [info, setInfo] = useState<AppUpdateInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState(0);
  const [contentLength, setContentLength] = useState<number | null>(null);
  const updateRef = useRef<Update | null>(null);

  const clearPendingUpdate = useCallback(() => {
    updateRef.current?.close().catch(() => {});
    updateRef.current = null;
  }, []);

  const checkForUpdate = useCallback(
    async (silent = false) => {
      if (!isTauri) {
        setPhase("idle");
        return;
      }
      setPhase("checking");
      setError(null);
      setDownloaded(0);
      setContentLength(null);
      try {
        const update = await check({ timeout: 30_000 });
        clearPendingUpdate();
        updateRef.current = update;
        if (update) {
          setInfo(updateInfo(update));
          setPhase("available");
        } else {
          setInfo(null);
          setPhase("current");
        }
      } catch (e) {
        setInfo(null);
        setError(String(e));
        setPhase(silent ? "idle" : "error");
      }
    },
    [clearPendingUpdate]
  );

  const installAndRestart = useCallback(async () => {
    if (!updateRef.current) {
      await checkForUpdate();
      if (!updateRef.current) return;
    }

    let received = 0;
    setPhase("downloading");
    setError(null);
    setDownloaded(0);
    setContentLength(null);
    try {
      await updateRef.current.downloadAndInstall((event: DownloadEvent) => {
        if (event.event === "Started") {
          setContentLength(event.data.contentLength ?? null);
        } else if (event.event === "Progress") {
          received += event.data.chunkLength;
          setDownloaded(received);
        }
      });
      clearPendingUpdate();
      setPhase("restarting");
      await relaunch();
    } catch (e) {
      setError(String(e));
      setPhase("error");
    }
  }, [checkForUpdate, clearPendingUpdate]);

  useEffect(() => {
    if (!autoCheck || !isTauri) return;
    checkForUpdate(true);
    return clearPendingUpdate;
  }, [autoCheck, checkForUpdate, clearPendingUpdate]);

  const progress =
    contentLength && contentLength > 0
      ? Math.max(0, Math.min(100, Math.round((downloaded / contentLength) * 100)))
      : null;

  return {
    phase,
    info,
    error,
    downloaded,
    contentLength,
    progress,
    checkForUpdate,
    installAndRestart,
  };
}

function App() {
  const t = useT();
  const [uiLang] = useLang();
  const [courses, setCourses] = useState<Course[]>([]);
  const [view, setView] = useState<View>({ kind: "empty" });
  const [jobs, setJobs] = useState<Map<string, JobState>>(new Map());
  const [translateStatus, setTranslateStatus] = useState<
    Map<string, { done: number; total: number; complete: boolean }>
  >(new Map());
  const [stages, setStages] = useState<Map<string, StageDetail>>(new Map());
  const [transcripts, setTranscripts] = useState<Map<string, Bubble[]>>(new Map());
  const [subErrors, setSubErrors] = useState<Map<string, string>>(new Map());
  const [recentCourseIds, setRecentCourseIds] = useState<string[]>(readRecentCourseIds);
  const [wizardQuestionsById, setWizardQuestionsById] = useState<Map<string, Question[]>>(
    new Map()
  );
  // Submodules that are readable but still backfilling images + test.
  const [enrichingSubs, setEnrichingSubs] = useState<Set<string>>(new Set());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [agentAvail, setAgentAvail] = useState<AgentAvailability | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [braveConfigured, setBraveConfigured] = useState<boolean | null>(null);
  const [geminiConfigured, setGeminiConfigured] = useState<boolean | null>(null);
  const [debugLogging, setDebugLogging] = useState(false);
  const [modelSettings, setModelSettings] = useState<ModelConfig | null>(null);
  const [sidebarLanguageFilter, setSidebarLanguageFilter] = useState("all");
  const [homeTitleTextStyles, setHomeTitleTextStyles] = useState<HomeTitleTextStyles>({
    main: "",
    almost: "",
  });
  const [courseSuggestion, setCourseSuggestion] = useState<CourseSuggestionState>({
    status: "idle",
  });
  const courseSuggestionRunningRef = useRef(false);
  const courseSuggestionRequestedRef = useRef(false);
  const sidebarLanguageOptions = useMemo(() => getCourseLanguageOptions(courses), [courses]);
  useEffect(() => {
    if (
      sidebarLanguageFilter !== "all" &&
      !sidebarLanguageOptions.some((option) => option.code === sidebarLanguageFilter)
    ) {
      setSidebarLanguageFilter("all");
    }
  }, [sidebarLanguageFilter, sidebarLanguageOptions]);

  // Open external http(s) links (course content + anywhere else) in the system
  // browser instead of navigating the app's own webview away from the app.
  useEffect(() => {
    if (!isTauri) return;
    const onClick = (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement | null)?.closest?.("a");
      const href = anchor?.getAttribute("href");
      if (!href || !/^https?:\/\//i.test(href)) return;
      e.preventDefault();
      openUrl(href).catch(() => {});
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);
  // When viewing a space (or a course/submodule that belongs to one), scope the
  // sidebar to that space's courses.
  const activeSpaceId = useMemo(() => {
    if (view.kind === "space") return view.id;
    if (view.kind === "course") return courses.find((c) => c.id === view.id)?.space_id ?? null;
    if (view.kind === "submodule")
      return courses.find((c) => c.id === view.courseId)?.space_id ?? null;
    return null;
  }, [view, courses]);
  const sidebarCourses = useMemo(() => {
    let list = activeSpaceId ? courses.filter((c) => c.space_id === activeSpaceId) : courses;
    if (!activeSpaceId && sidebarLanguageFilter !== "all") {
      list = list.filter(
        (course) => (course.language || "").trim().toLowerCase() === sidebarLanguageFilter
      );
    }
    return list;
  }, [courses, sidebarLanguageFilter, activeSpaceId]);
  const [spaceNames, setSpaceNames] = useState<Record<string, string>>({});
  useEffect(() => {
    invoke<Space[]>("list_spaces")
      .then((list) => setSpaceNames(Object.fromEntries(list.map((s) => [s.id, s.name]))))
      .catch(() => {});
  }, [courses]);

  const refreshCapabilities = useCallback(async () => {
    const [aa, ss, ms, rt] = await Promise.allSettled([
      invoke<AgentAvailability>("check_agent_availability"),
      invoke<{ brave_configured: boolean; gemini_configured?: boolean; debug_logging?: boolean }>(
        "get_settings_status"
      ),
      invoke<ModelConfig>("get_model_settings"),
      invoke<string | null>("sidecar_status"),
    ]);
    if (aa.status === "fulfilled") setAgentAvail(aa.value);
    if (rt.status === "fulfilled") setRuntimeError(rt.value ?? null);
    if (ss.status === "fulfilled") {
      setBraveConfigured(ss.value.brave_configured);
      setGeminiConfigured(Boolean(ss.value.gemini_configured));
      setDebugLogging(Boolean(ss.value.debug_logging));
    }
    if (ms.status === "fulfilled") setModelSettings(ms.value);
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
    let cancelled = false;
    const wizardCourses = courses.filter((course) => course.status === "wizard");
    if (wizardCourses.length === 0) {
      setWizardQuestionsById(new Map());
      return;
    }
    Promise.all(
      wizardCourses.map(async (course) => {
        try {
          const questions = await invoke<Question[]>("get_wizard_questions", {
            courseId: course.id,
          });
          return [course.id, Array.isArray(questions) ? questions : []] as const;
        } catch {
          return [course.id, [] as Question[]] as const;
        }
      })
    ).then((entries) => {
      if (!cancelled) setWizardQuestionsById(new Map(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [courses]);

  const rememberCourseOpen = useCallback((courseId: string) => {
    setRecentCourseIds((prev) => {
      const next = [courseId, ...prev.filter((id) => id !== courseId)].slice(0, 12);
      localStorage.setItem(RECENT_COURSES_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const openCourse = useCallback(
    (courseId: string) => {
      rememberCourseOpen(courseId);
      setView({ kind: "course", id: courseId });
    },
    [rememberCourseOpen]
  );

  const openSubmodule = useCallback(
    (courseId: string, moduleId: string, submoduleId: string) => {
      rememberCourseOpen(courseId);
      setView({ kind: "submodule", courseId, moduleId, submoduleId });
    },
    [rememberCourseOpen]
  );

  useEffect(() => {
    const unlistenP = listen<JobEvent>("agent_job", async (e) => {
      const { courseId, kind, ok, result, error } = e.payload;
      setJobs((prev) => {
        const next = new Map(prev);
        next.set(
          jobKey(courseId, kind),
          ok
            ? { kind, status: "done", result }
            : {
                kind,
                status: "error",
                error: error ?? "unknown",
                exhausted: (e.payload as { exhausted?: boolean }).exhausted,
                agent: (e.payload as { agent?: string }).agent,
              }
        );
        return next;
      });
      if (kind === "translate") {
        const pl = e.payload as { done?: number; total?: number };
        setTranslateStatus((prev) => {
          const next = new Map(prev);
          next.set(courseId, {
            done: ok ? pl.total ?? 0 : pl.done ?? 0,
            total: pl.total ?? 0,
            complete: !!ok,
          });
          return next;
        });
      }
      if (kind === "wizard_questions" && ok) {
        const questions = (result as { questions?: Question[] } | undefined)?.questions ?? [];
        setWizardQuestionsById((prev) => {
          const next = new Map(prev);
          next.set(courseId, questions);
          return next;
        });
      }
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

  useEffect(() => {
    const unlistenP = listen<CourseSuggestionEvent>("course_suggestion", (e) => {
      if (!courseSuggestionRequestedRef.current) return;
      const payload = e.payload;
      const topic = payload.topic?.trim();
      courseSuggestionRunningRef.current = false;
      courseSuggestionRequestedRef.current = false;
      if (payload.ok && topic) {
        setCourseSuggestion({
          status: "ready",
          idea: {
            topic,
            title: payload.title?.trim() || topic,
            reason: payload.reason?.trim(),
            agent: payload.agent === "claude" ? "claude" : "codex",
            language: normalizeCourseLanguage(payload.language) || initialCourseLanguage(),
          },
        });
      } else {
        setCourseSuggestion({
          status: "error",
          error: payload.error || "suggestion failed",
        });
      }
    });
    return () => {
      unlistenP.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    document.title =
      courseSuggestion.status === "ready" ? courseSuggestion.idea.topic : t("brand");
  }, [courseSuggestion, t]);

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
        next.set(courseId, [
          {
            kind: "running",
            text: kind === "build_structure" ? t("buildingStructure") : t("wizardThinking"),
          },
        ]);
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

  function randomHomeTitleSegmentClass(current: string) {
    const pick = (classes: string[]) => classes[Math.floor(Math.random() * classes.length)];
    let next = "";
    for (let attempt = 0; attempt < 4; attempt += 1) {
      next = [
        pick(HOME_TITLE_FONT_CLASSES),
        pick(HOME_TITLE_WEIGHT_CLASSES),
        pick(HOME_TITLE_SLANT_CLASSES),
      ].join(" ");
      if (next !== current) break;
    }
    return next;
  }

  function randomizeHomeTitleFont() {
    setHomeTitleTextStyles((current) => ({
      main: randomHomeTitleSegmentClass(current.main),
      almost: randomHomeTitleSegmentClass(current.almost),
    }));
  }

  async function startCourseSuggestion() {
    randomizeHomeTitleFont();
    if (courseSuggestion.status === "running" || courseSuggestionRunningRef.current) return;
    const backend =
      agentAvail?.claude ? "claude" : agentAvail?.codex ? "codex" : null;
    const language = initialCourseLanguage();
    courseSuggestionRequestedRef.current = true;
    courseSuggestionRunningRef.current = true;
    setCourseSuggestion({ status: "running" });
    try {
      await invoke("start_course_suggestion", { backend, language });
    } catch (e) {
      courseSuggestionRequestedRef.current = false;
      courseSuggestionRunningRef.current = false;
      setCourseSuggestion({ status: "error", error: String(e) });
    }
  }

  async function studySuggestedCourse() {
    if (courseSuggestion.status !== "ready") return;
    const idea = courseSuggestion.idea;
    const agent =
      agentAvail?.[idea.agent] !== false
        ? idea.agent
        : agentAvail?.claude
          ? "claude"
          : agentAvail?.codex
            ? "codex"
            : idea.agent;
    try {
      const id = await invoke<string>("create_course", {
        topic: idea.topic,
        language: idea.language,
        courseFormat: DEFAULT_COURSE_FORMAT,
        agent,
      });
      setCourseSuggestion({ status: "idle" });
      await refresh();
      openCourse(id);
      await startJob(id, "wizard_questions");
    } catch (e) {
      setCourseSuggestion({ status: "error", error: String(e) });
    }
  }

  const isHome = view.kind === "empty";
  const menuHidden = view.kind !== "empty";
  const appBrand = t("brand");
  const appAlmost = "(Almost)";
  const appAlmostIndex = appBrand.indexOf(appAlmost);
  return (
    <AudioPlayerProvider>
    <div className={`app${menuHidden ? " menu-hidden" : ""}${isHome ? " home-view" : ""}`}>
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-mark" src={appMark} alt="" aria-hidden="true" />
          <span className="brand-name">
            {appAlmostIndex >= 0 ? (
              <>
                {appBrand.slice(0, appAlmostIndex)}
                <span className="brand-soft">{appAlmost}</span>
                {appBrand.slice(appAlmostIndex + appAlmost.length)}
              </>
            ) : (
              appBrand
            )}
          </span>
          <button
            className="brand-settings"
            onClick={() => setSettingsOpen(true)}
            title={t("settings")}
            aria-label={t("settings")}
          >
            <SettingsIcon />
          </button>
        </div>
        <button
          className="new-course"
          onClick={() => setView({ kind: "creating", spaceId: activeSpaceId ?? undefined })}
        >
          {t("newCourse")}
        </button>
        <div className="sidebar-links">
          <button
            className={`sidebar-link ${view.kind === "spaces" || view.kind === "space" ? "active" : ""}`}
            onClick={() => setView({ kind: "spaces" })}
          >
            {t("spacesNav")}
          </button>
          <button
            className={`sidebar-link ${view.kind === "catalog" ? "active" : ""}`}
            onClick={() => setView({ kind: "catalog" })}
          >
            {t("catalogOpen")}
          </button>
        </div>
        {activeSpaceId && (
          <div className="sidebar-space-scope">
            <span className="sidebar-space-name">
              {spaceNames[activeSpaceId] ?? t("spacesTitle")}
            </span>
            <button
              className="sidebar-space-clear"
              onClick={() => setView({ kind: "empty" })}
              title={t("sidebarAllCourses")}
            >
              {t("sidebarAllCourses")}
            </button>
          </div>
        )}
        {!activeSpaceId && courses.length > 0 && sidebarLanguageOptions.length > 1 && (
          <div className="sidebar-language-filter" aria-label={t("homeLanguageFilterLabel")}>
            <button
              className={sidebarLanguageFilter === "all" ? "active" : ""}
              onClick={() => setSidebarLanguageFilter("all")}
              aria-pressed={sidebarLanguageFilter === "all"}
            >
              {t("sidebarLanguageAll")}
              <span>{courses.length}</span>
            </button>
            {sidebarLanguageOptions.map((option) => (
              <button
                key={option.code}
                className={sidebarLanguageFilter === option.code ? "active" : ""}
                onClick={() => setSidebarLanguageFilter(option.code)}
                aria-pressed={sidebarLanguageFilter === option.code}
                title={courseLanguageLabel(option.code, uiLang)}
              >
                {option.code.toUpperCase()}
                <span>{option.count}</span>
              </button>
            ))}
          </div>
        )}
        <ul className="course-list">
          {sidebarCourses.map((c) => {
            const hasRunning = ["wizard_questions", "build_structure"].some(
              (k) => jobs.get(jobKey(c.id, k as JobKind))?.status === "running"
            );
            return (
              <li
                key={c.id}
                className={view.kind === "course" && view.id === c.id ? "active" : ""}
                onClick={() => openCourse(c.id)}
              >
                <div className="course-topic">
                  {courseTitle(c, t("courseTitlePending"))}
                  {hasRunning && <span className="spinner" title={t("generatingTitle")} />}
                </div>
                <div className="course-meta">
                  {c.language}
                  {categoryLabel(c.category, uiLang) && ` · ${categoryLabel(c.category, uiLang)}`}
                  {" · "}
                  {courseLifecycleStatusLabel(c.status, t)}
                </div>
              </li>
            );
          })}
          {courses.length === 0 && <li className="empty-hint">{t("noCourses")}</li>}
          {courses.length > 0 && sidebarCourses.length === 0 && (
            <li className="empty-hint">{t("homeNoOtherCourses")}</li>
          )}
        </ul>
      </aside>

      <main className="main">
        <div className={`main-inner ${view.kind === "empty" ? "home-main" : ""}`}>
        <CapabilityBanners
          agentAvail={agentAvail}
          runtimeError={runtimeError}
          braveConfigured={braveConfigured}
          geminiConfigured={geminiConfigured}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        <AppUpdateBanner />
        {(view.kind === "catalog" ||
          view.kind === "spaces" ||
          view.kind === "space" ||
          view.kind === "course" ||
          view.kind === "submodule") && (
          <nav className="crumbs">
            <button className="crumb" onClick={() => setView({ kind: "empty" })}>
              {t("crumbCourses")}
            </button>
            {view.kind === "catalog" && (
              <>
                <span className="crumb-sep">›</span>
                <span className="crumb current">{t("catalogTitle")}</span>
              </>
            )}
            {(view.kind === "spaces" || view.kind === "space") && (
              <>
                <span className="crumb-sep">›</span>
                {view.kind === "space" ? (
                  <button className="crumb" onClick={() => setView({ kind: "spaces" })}>
                    {t("spacesTitle")}
                  </button>
                ) : (
                  <span className="crumb current">{t("spacesTitle")}</span>
                )}
              </>
            )}
            {view.kind === "submodule" && (
              <>
                <span className="crumb-sep">›</span>
                <button
                  className="crumb"
                  onClick={() => openCourse(view.courseId)}
                >
                  {(() => {
                    const course = courses.find((c) => c.id === view.courseId);
                    return course ? courseTitle(course, t("courseTitlePending")) : "…";
                  })()}
                </button>
              </>
            )}
          </nav>
        )}
        {view.kind === "empty" && (
          <CourseDashboard
            courses={courses}
            jobs={jobs}
            agentAvail={agentAvail}
            braveConfigured={braveConfigured}
            geminiConfigured={geminiConfigured}
            modelSettings={modelSettings}
            recentCourseIds={recentCourseIds}
            wizardQuestionsById={wizardQuestionsById}
            courseSuggestion={courseSuggestion}
            homeTitleTextStyles={homeTitleTextStyles}
            onNewCourse={() => setView({ kind: "creating" })}
            onOpenCatalog={() => setView({ kind: "catalog" })}
            onOpenSpaces={() => setView({ kind: "spaces" })}
            onOpenSpace={(id) => setView({ kind: "space", id })}
            onOpenSettings={() => setSettingsOpen(true)}
            onHomeTitleTap={startCourseSuggestion}
            onStudySuggestion={studySuggestedCourse}
            onOpenCourse={openCourse}
            onStartJob={startJob}
            onOpenSub={openSubmodule}
            onStartSubGen={startSubmoduleGen}
          />
        )}
        {view.kind === "creating" && (
          <CreateCourse
            agentAvail={agentAvail}
            spaceId={view.spaceId}
            onCreated={async (id) => {
              await refresh();
              openCourse(id);
            }}
            onCancel={() => setView({ kind: "empty" })}
          />
        )}
        {view.kind === "catalog" && (
          <CatalogView
            onImported={async (courseId) => {
              await refresh();
              openCourse(courseId);
            }}
          />
        )}
        {view.kind === "spaces" && (
          <SpacesView onOpenSpace={(id) => setView({ kind: "space", id })} />
        )}
        {view.kind === "space" && (
          <SpaceView spaceId={view.id} onBack={() => setView({ kind: "spaces" })} />
        )}
        {view.kind === "course" && (
          <CourseView
            course={courses.find((c) => c.id === view.id)}
            jobs={jobs}
            savedWizardQuestions={wizardQuestionsById.get(view.id) ?? []}
            structureTranscript={transcripts.get(view.id) ?? null}
            onStartJob={(kind) => startJob(view.id, kind)}
            onChanged={refresh}
            onOpenSub={(moduleId, submoduleId) =>
              openSubmodule(view.id, moduleId, submoduleId)
            }
            onStartSubGen={(submoduleId) => startSubmoduleGen(view.id, submoduleId)}
            onDeleted={async () => {
              setView({ kind: "empty" });
              await refresh();
            }}
            onOpenCourse={openCourse}
            translateStatus={translateStatus.get(view.id)}
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
            onOpenSubmodule={(moduleId, submoduleId) =>
              openSubmodule(view.courseId, moduleId, submoduleId)
            }
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
          onDebugLoggingChange={setDebugLogging}
        />
      )}

      {debugLogging && <DevLogPanel />}
    </div>
    </AudioPlayerProvider>
  );
}

// --- Dev log structured rendering (collapsible JSON, framed blocks) ---

type LogEvent = {
  type: "request" | "frame" | "note";
  key: string;
  reqId: string;
  method: string;
  course: string;
  tone: string;
  // request/note payload:
  text?: string;
  // frame payload:
  header?: string;
  label?: string;
  body?: string;
};

const REQUEST_RE = /\]\s[▶✓✗]\s?REQUEST\s/;

function reqIdOf(line: string): string {
  const m = line.match(/#(\d+)/);
  return m ? m[1] : "";
}

// Parse the raw log into ordered events, each tagged with its request's
// method (action) + course (topic) so the panel can filter by them. reqId ties
// streaming reasoning/tool notes back to their originating request.
function parseDevLog(text: string): LogEvent[] {
  const lines = text.split("\n");
  const events: LogEvent[] = [];
  const registry = new Map<string, { method: string; course: string }>();
  const remember = (reqId: string, method?: string, course?: string) => {
    if (!reqId) return;
    const cur = registry.get(reqId) || { method: "", course: "" };
    if (method) cur.method = method;
    if (course) cur.course = course;
    registry.set(reqId, cur);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("┌")) {
      const header = line;
      let label = "";
      if (i + 1 < lines.length && lines[i + 1].startsWith("│")) {
        label = lines[i + 1].replace(/^│\s?/, "");
        i += 1;
      }
      const body: string[] = [];
      while (i + 1 < lines.length && !lines[i + 1].startsWith("└")) {
        body.push(lines[i + 1]);
        i += 1;
      }
      if (i + 1 < lines.length && lines[i + 1].startsWith("└")) i += 1; // consume └ rule
      const reqId = reqIdOf(header);
      const method =
        header.match(/\[#\d+\]\s+(\S+)/)?.[1] || header.match(/[✓✗]\s+(\S+)\s+#\d+/)?.[1] || "";
      const course = header.match(/course="([^"]*)"/)?.[1] || "";
      remember(reqId, method, course);
      const tone = /RESPONSE/i.test(label)
        ? "response"
        : /ERROR/i.test(label)
          ? "error"
          : /PROMPT/i.test(label)
            ? "prompt"
            : "plain";
      events.push({ type: "frame", key: `f${header}`, reqId, method, course, tone, header, label, body: body.join("\n") });
    } else if (REQUEST_RE.test(line)) {
      const reqId = reqIdOf(line);
      const method = line.match(/REQUEST\s+(\S+)\s+#\d+/)?.[1] || "";
      const course = line.match(/course="([^"]*)"/)?.[1] || "";
      remember(reqId, method, course);
      events.push({
        type: "request",
        key: `r${i}`,
        reqId,
        method,
        course,
        tone: /✗/.test(line) ? "error" : "request",
        text: line,
      });
    } else if (line.startsWith("·")) {
      const reqId = reqIdOf(line);
      const buf = [line];
      while (
        i + 1 < lines.length &&
        !lines[i + 1].startsWith("·") &&
        !lines[i + 1].startsWith("┌") &&
        !REQUEST_RE.test(lines[i + 1]) &&
        !/^─{3,}/.test(lines[i + 1])
      ) {
        buf.push(lines[i + 1]);
        i += 1;
      }
      events.push({ type: "note", key: `n${i}`, reqId, method: "", course: "", tone: "note", text: buf.join("\n") });
    } else {
      if (/^─{3,}/.test(line) || line.trim() === "") continue;
      events.push({ type: "note", key: `x${i}`, reqId: "", method: "", course: "", tone: "note", text: line });
    }
  }

  // Notes carry only a reqId; backfill their method/course from the registry so
  // filtering by topic/action also catches the reasoning chain.
  for (const e of events) {
    if (e.reqId && (!e.course || !e.method)) {
      const r = registry.get(e.reqId);
      if (r) {
        if (!e.course) e.course = r.course;
        if (!e.method) e.method = r.method;
      }
    }
  }
  return events;
}

function distinct(arr: string[]): string[] {
  return Array.from(new Set(arr.filter(Boolean)));
}

// Best-effort: pull a JSON value out of a block body (raw, fenced, or embedded).
function tryParseJson(body: string): unknown | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  const candidates: string[] = [];
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) candidates.push(fence[1]);
  if (trimmed[0] === "{" || trimmed[0] === "[") candidates.push(trimmed);
  const first = trimmed.search(/[[{]/);
  const last = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

const STR_LIMIT = 180;

function JsonScalar({ value }: { value: unknown }) {
  const [expanded, setExpanded] = useState(false);
  if (typeof value === "string") {
    const long = value.length > STR_LIMIT;
    if (long && !expanded) {
      return (
        <span className="jv-str jv-clip" onClick={() => setExpanded(true)} title="развернуть">
          "{value.slice(0, STR_LIMIT)}
          <span className="jv-more">… +{value.length - STR_LIMIT}</span>"
        </span>
      );
    }
    return (
      <span
        className={long ? "jv-str jv-clip" : "jv-str"}
        onClick={() => long && setExpanded(false)}
      >
        "{value}"
      </span>
    );
  }
  if (value === null) return <span className="jv-null">null</span>;
  if (typeof value === "number") return <span className="jv-num">{String(value)}</span>;
  if (typeof value === "boolean") return <span className="jv-bool">{String(value)}</span>;
  return <span>{String(value)}</span>;
}

function JsonNode({
  k,
  value,
  depth,
}: {
  k?: string | number;
  value: unknown;
  depth: number;
}) {
  const isObj = value !== null && typeof value === "object";
  const [open, setOpen] = useState(depth < 1);
  const pad = { paddingLeft: depth * 14 } as CSSProperties;
  if (!isObj) {
    return (
      <div className="jv-row" style={pad}>
        {k !== undefined && <span className="jv-key">{k}:</span>} <JsonScalar value={value} />
      </div>
    );
  }
  const isArr = Array.isArray(value);
  const entries: [string | number, unknown][] = isArr
    ? (value as unknown[]).map((v, i) => [i, v])
    : Object.entries(value as Record<string, unknown>);
  return (
    <div className="jv-node">
      <div className="jv-row jv-toggle" style={pad} onClick={() => setOpen((o) => !o)}>
        <span className="jv-caret">{open ? "▾" : "▸"}</span>
        {k !== undefined && <span className="jv-key">{k}:</span>}
        <span className="jv-brace">{isArr ? "[" : "{"}</span>
        {!open && (
          <span className="jv-collapsed">
            {entries.length}
            {isArr ? "]" : "}"}
          </span>
        )}
      </div>
      {open && (
        <>
          {entries.map(([ck, cv]) => (
            <JsonNode key={ck} k={ck} value={cv} depth={depth + 1} />
          ))}
          <div className="jv-row" style={pad}>
            <span className="jv-brace">{isArr ? "]" : "}"}</span>
          </div>
        </>
      )}
    </div>
  );
}

function LogFrame({ block }: { block: LogEvent }) {
  const body = block.body ?? "";
  const json = useMemo(() => tryParseJson(body), [body]);
  const big = body.length > 400;
  const [open, setOpen] = useState(block.tone === "response" || block.tone === "error" || !big);
  const title = (block.header ?? "").replace(/^┌─/, "").trim();
  return (
    <div className={`devlog-frame tone-${block.tone}`}>
      <div className="devlog-frame-head" onClick={() => setOpen((o) => !o)}>
        <span className="jv-caret">{open ? "▾" : "▸"}</span>
        <span className="devlog-frame-title">{title}</span>
        <span className="devlog-frame-label">
          {block.label}
          {json ? " · json" : ""}
        </span>
      </div>
      {open &&
        (json ? (
          <div className="jv-root">
            <JsonNode value={json} depth={0} />
          </div>
        ) : (
          <pre className="devlog-frame-body">{block.body}</pre>
        ))}
    </div>
  );
}

function DevLogContent({ events }: { events: LogEvent[] }) {
  return (
    <>
      {events.map((e) =>
        e.type === "frame" ? (
          <LogFrame key={e.key} block={e} />
        ) : e.type === "request" ? (
          <div key={e.key} className={`devlog-req tone-${e.tone}`}>
            {e.text}
          </div>
        ) : (
          <pre key={e.key} className="devlog-loose">
            {e.text}
          </pre>
        )
      )}
    </>
  );
}

// Dev-only debug panel: live tail of the sidecar agent transcript log
// (prompts, reasoning, tool calls, responses). Only mounted in `pnpm tauri dev`
// (import.meta.env.DEV); never shipped in a production build.
function DevLogPanel() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [paused, setPaused] = useState(false);
  const [raw, setRaw] = useState(false);
  const [methodFilter, setMethodFilter] = useState("");
  const [courseFilter, setCourseFilter] = useState("");
  const [q, setQ] = useState("");
  const preRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const events = useMemo(() => parseDevLog(text), [text]);
  const methods = useMemo(() => distinct(events.map((e) => e.method)), [events]);
  const courses = useMemo(() => distinct(events.map((e) => e.course)), [events]);
  const shown = useMemo(
    () =>
      events.filter((e) => {
        if (methodFilter && e.method !== methodFilter) return false;
        if (courseFilter && e.course !== courseFilter) return false;
        if (q) {
          const hay = (
            e.type === "frame" ? `${e.header} ${e.label} ${e.body}` : e.text || ""
          ).toLowerCase();
          if (!hay.includes(q.toLowerCase())) return false;
        }
        return true;
      }),
    [events, methodFilter, courseFilter, q]
  );
  const filtered = Boolean(methodFilter || courseFilter || q);

  useEffect(() => {
    if (!open || paused) return;
    let alive = true;
    const poll = async () => {
      try {
        const s = await invoke<string>("read_dev_log", { maxBytes: 400_000 });
        if (alive) setText(s);
      } catch {
        /* ignore transient read errors */
      }
    };
    poll();
    const id = setInterval(poll, 1500);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [open, paused]);

  useEffect(() => {
    const el = preRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [text]);

  function onScroll() {
    const el = preRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }

  async function clearLog() {
    try {
      await invoke("clear_dev_log");
      setText("");
    } catch {
      /* ignore */
    }
  }

  return (
    <>
      <button
        className="devlog-fab"
        onClick={() => setOpen((o) => !o)}
        title="Agent logs (dev)"
        aria-label="Toggle agent logs"
      >
        🐛
      </button>
      {open && (
        <div className="devlog-panel">
          <div className="devlog-head">
            <span className="devlog-title">agent logs</span>
            <div className="devlog-actions">
              <button onClick={() => setRaw((r) => !r)}>{raw ? "pretty" : "raw"}</button>
              <button onClick={() => setPaused((p) => !p)}>{paused ? "▶ resume" : "⏸ pause"}</button>
              <button onClick={clearLog}>clear</button>
              <button onClick={() => setOpen(false)}>✕</button>
            </div>
          </div>
          {!raw && (
            <div className="devlog-filters">
              <select value={methodFilter} onChange={(e) => setMethodFilter(e.target.value)}>
                <option value="">все действия</option>
                {methods.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <select value={courseFilter} onChange={(e) => setCourseFilter(e.target.value)}>
                <option value="">все топики</option>
                {courses.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <input
                placeholder="поиск…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
              {filtered && (
                <button
                  onClick={() => {
                    setMethodFilter("");
                    setCourseFilter("");
                    setQ("");
                  }}
                >
                  сброс
                </button>
              )}
            </div>
          )}
          <div ref={preRef} className="devlog-body" onScroll={onScroll}>
            {!text ? (
              <pre className="devlog-loose">
                — пусто. Запусти генерацию раздела, и здесь появятся промпты, reasoning и ответы
                агентов. —
              </pre>
            ) : raw ? (
              <pre className="devlog-loose">{text}</pre>
            ) : shown.length === 0 ? (
              <pre className="devlog-loose">— нет записей под фильтр —</pre>
            ) : (
              <DevLogContent events={shown} />
            )}
          </div>
        </div>
      )}
    </>
  );
}

const CAPABILITY_SUGGESTION_DISMISSED_KEY = "learn.capabilitySuggestionDismissed";

function CapabilityBanners({
  agentAvail,
  runtimeError,
  braveConfigured,
  geminiConfigured,
  onOpenSettings,
}: {
  agentAvail: { claude: boolean; codex: boolean } | null;
  runtimeError: string | null;
  braveConfigured: boolean | null;
  geminiConfigured: boolean | null;
  onOpenSettings: () => void;
}) {
  const t = useT();
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(CAPABILITY_SUGGESTION_DISMISSED_KEY) === "1"
  );
  // Hard blocker: the agent runtime (Node.js sidecar) didn't start. Nothing can
  // be generated until it's fixed, so surface it above everything else.
  if (runtimeError) {
    return (
      <div className="banner banner-error" role="alert">
        <div className="banner-title">{t("runtimeMissingTitle")}</div>
        <div className="banner-body">{t("runtimeMissingBody")}</div>
        <div className="banner-detail">{runtimeError}</div>
      </div>
    );
  }
  if (!agentAvail) return null; // still loading
  // A real blocker — no agent CLI at all — stays a hard alert.
  const noAgents = !agentAvail.claude && !agentAvail.codex;
  if (noAgents) {
    return (
      <div className="banner banner-error" role="alert">
        <div className="banner-title">{t("noAgentsTitle")}</div>
        <div className="banner-body">{t("noAgentsBody")}</div>
      </div>
    );
  }
  // Brave/Gemini are optional quality boosters — show a soft, permanently
  // dismissible suggestion, never an alert.
  if (dismissed) return null;
  const missing: string[] = [];
  if (braveConfigured === false) missing.push("Brave Search");
  if (geminiConfigured === false) missing.push("Gemini");
  if (missing.length === 0) return null;
  return (
    <div className="banner banner-suggest">
      <div className="banner-main">
        <div className="banner-title">{t("qualitySuggestionTitle")}</div>
        <div className="banner-body">
          {t("qualitySuggestionBody", { services: missing.join(", ") })}
        </div>
      </div>
      <div className="banner-actions">
        <button className="banner-action" onClick={onOpenSettings}>
          {t("openSettings")}
        </button>
        <button
          className="banner-dismiss"
          onClick={() => {
            localStorage.setItem(CAPABILITY_SUGGESTION_DISMISSED_KEY, "1");
            setDismissed(true);
          }}
        >
          {t("qualityDismiss")}
        </button>
      </div>
    </div>
  );
}

function AppUpdateBanner() {
  const t = useT();
  const updater = useAppUpdater(true);
  if (!updater.info || !["available", "downloading", "restarting", "error"].includes(updater.phase)) {
    return null;
  }

  const installing = updater.phase === "downloading" || updater.phase === "restarting";
  return (
    <div className="banner banner-update">
      <div className="banner-main">
        <div className="banner-title">
          {t("appUpdateBannerTitle", { version: updater.info.version })}
        </div>
        <div className="banner-body">
          {updater.phase === "downloading"
            ? updateProgressLabel(t, updater)
            : updater.phase === "restarting"
              ? t("appUpdateRestarting")
              : updater.error
                ? t("appUpdateError", { error: updater.error })
                : t("appUpdateBannerBody")}
        </div>
      </div>
      <button
        className="banner-action"
        onClick={updater.installAndRestart}
        disabled={installing}
      >
        {installing ? t("appUpdateInstalling") : t("appUpdateInstallRestart")}
      </button>
    </div>
  );
}

function updateProgressLabel(
  t: ReturnType<typeof useT>,
  updater: ReturnType<typeof useAppUpdater>
) {
  if (updater.progress !== null && updater.contentLength) {
    return t("appUpdateProgress", {
      percent: updater.progress,
      downloaded: formatBytes(updater.downloaded),
      total: formatBytes(updater.contentLength),
    });
  }
  return t("appUpdateDownloading", { downloaded: formatBytes(updater.downloaded) });
}

function CourseDashboard({
  courses,
  jobs,
  agentAvail,
  braveConfigured,
  geminiConfigured,
  modelSettings,
  recentCourseIds,
  wizardQuestionsById,
  courseSuggestion,
  homeTitleTextStyles,
  onNewCourse,
  onOpenCatalog,
  onOpenSpaces,
  onOpenSpace,
  onOpenSettings,
  onHomeTitleTap,
  onStudySuggestion,
  onOpenCourse,
  onStartJob,
  onOpenSub,
  onStartSubGen,
}: {
  courses: Course[];
  jobs: Map<string, JobState>;
  agentAvail: AgentAvailability | null;
  braveConfigured: boolean | null;
  geminiConfigured: boolean | null;
  modelSettings: ModelConfig | null;
  recentCourseIds: string[];
  wizardQuestionsById: Map<string, Question[]>;
  courseSuggestion: CourseSuggestionState;
  homeTitleTextStyles: HomeTitleTextStyles;
  onNewCourse: () => void;
  onOpenCatalog: () => void;
  onOpenSpaces: () => void;
  onOpenSpace: (id: string) => void;
  onOpenSettings: () => void;
  onHomeTitleTap: () => void;
  onStudySuggestion: () => void;
  onOpenCourse: (courseId: string) => void;
  onStartJob: (courseId: string, kind: JobKind) => void;
  onOpenSub: (courseId: string, moduleId: string, submoduleId: string) => void;
  onStartSubGen: (courseId: string, submoduleId: string) => void | Promise<void>;
}) {
  const t = useT();
  const [uiLang] = useLang();
  const [progressById, setProgressById] = useState<Map<string, CourseProgress>>(new Map());
  const [languageFilter, setLanguageFilter] = useState("all");
  const [spaces, setSpaces] = useState<Space[]>([]);
  useEffect(() => {
    invoke<Space[]>("list_spaces")
      .then(setSpaces)
      .catch(() => {});
  }, []);
  const languageOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const course of courses) {
      const code = (course.language || "").trim().toLowerCase() || "unknown";
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .sort(([a], [b]) => {
        const rankA = COURSE_LANGUAGES.findIndex((item) => item.code === a);
        const rankB = COURSE_LANGUAGES.findIndex((item) => item.code === b);
        const safeA = rankA === -1 ? Number.MAX_SAFE_INTEGER : rankA;
        const safeB = rankB === -1 ? Number.MAX_SAFE_INTEGER : rankB;
        return safeA - safeB || a.localeCompare(b);
      })
      .map(([code, count]) => ({ code, count }));
  }, [courses]);
  useEffect(() => {
    if (
      languageFilter !== "all" &&
      !languageOptions.some((option) => option.code === languageFilter)
    ) {
      setLanguageFilter("all");
    }
  }, [languageFilter, languageOptions]);
  const filteredCourses = useMemo(
    () =>
      languageFilter === "all"
        ? courses
        : courses.filter(
            (course) => (course.language || "").trim().toLowerCase() === languageFilter
          ),
    [courses, languageFilter]
  );
  const progressKey = filteredCourses.map((c) => `${c.id}:${c.status}:${c.updated_at}`).join("|");

  useEffect(() => {
    let cancelled = false;
    const readyCourses = filteredCourses.filter((course) => course.status === "ready");
    if (readyCourses.length === 0) {
      setProgressById(new Map());
      return;
    }
    Promise.all(
      readyCourses.map(async (course) => {
        try {
          const tree = await invoke<StructureFile>("get_structure", { courseId: course.id });
          return [course.id, summarizeStructure(tree)] as const;
        } catch {
          return [course.id, emptyProgress()] as const;
        }
      })
    ).then((entries) => {
      if (cancelled) return;
      setProgressById(new Map(entries));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progressKey]);

  const totals = filteredCourses.reduce(
    (acc, course) => {
      const progress = progressById.get(course.id);
      acc.courses += 1;
      if (progress) {
        acc.verified += progress.verified;
        acc.verifiedAt.push(...progress.verifiedAt);
        if (progress.nextReady) acc.readyToContinue += 1;
      }
      return acc;
    },
    { courses: 0, verified: 0, verifiedAt: [] as number[], readyToContinue: 0 }
  );

  const summaries = filteredCourses.map((course) => {
    const progress = progressById.get(course.id);
    const wizardJob = jobs.get(jobKey(course.id, "wizard_questions"));
    const structureJob = jobs.get(jobKey(course.id, "build_structure"));
    const verifiedPercent =
      progress && progress.total > 0 ? Math.round((progress.verified / progress.total) * 100) : 0;

    let actionLabel = t("courseActionOpen");
    let actionDisabled = false;
    let action = () => onOpenCourse(course.id);
    let statusText = t("courseStatusOpen");
    let needsAction = false;

    if (course.status === "wizard") {
      const savedQuestions = wizardQuestionsById.get(course.id) ?? [];
      if (wizardJob?.status === "running") {
        actionLabel = t("courseActionWorking");
        actionDisabled = true;
        statusText = t("courseStatusWorking");
      } else if (wizardJob?.status === "error") {
        actionLabel = t("courseActionRetry");
        action = () => onStartJob(course.id, "wizard_questions");
        statusText = t("courseStatusNeedsQuestions");
        needsAction = true;
      } else if ((wizardJob?.result as { questions?: Question[] } | undefined)?.questions?.length) {
        actionLabel = t("courseActionAnswerQuestions");
        statusText = t("courseStatusNeedsAnswers");
        needsAction = true;
      } else if (savedQuestions.length > 0) {
        actionLabel = t("courseActionAnswerQuestions");
        statusText = t("courseStatusNeedsAnswers");
        needsAction = true;
      } else {
        actionLabel = t("courseActionStartQuestions");
        action = () => onStartJob(course.id, "wizard_questions");
        statusText = t("courseStatusNeedsQuestions");
        needsAction = true;
      }
    } else if (course.status === "structuring") {
      if (structureJob?.status === "running") {
        actionLabel = t("courseActionWorking");
        actionDisabled = true;
        statusText = t("courseStatusWorking");
      } else {
        actionLabel = structureJob?.status === "error" ? t("courseActionRetry") : t("courseActionBuildPlan");
        action = () => onStartJob(course.id, "build_structure");
        statusText = t("courseStatusNeedsStructure");
        needsAction = true;
      }
    } else if (course.status === "ready") {
      if (!progress) {
        actionLabel = t("courseActionOpen");
        statusText = t("courseStatusLoading");
      } else if (progress.generating > 0) {
        actionLabel = t("courseActionWorking");
        actionDisabled = true;
        statusText = t("courseStatusWorking");
      } else if (progress.queued > 0) {
        actionLabel = t("courseActionOpen");
        statusText = t("courseStatusQueued");
        needsAction = true;
      } else if (progress.nextReady) {
        const next = progress.nextReady;
        actionLabel = t("courseActionContinue");
        action = () => onOpenSub(course.id, next.moduleId, next.submoduleId);
        statusText = t("courseStatusReady");
      } else if (progress.nextPending) {
        const next = progress.nextPending;
        actionLabel = t("courseActionGenerateNext");
        action = () => {
          onStartSubGen(course.id, next.submoduleId);
          onOpenSub(course.id, next.moduleId, next.submoduleId);
        };
        statusText = t("courseStatusNeedsGeneration");
        needsAction = true;
      } else if (progress.failed > 0) {
        actionLabel = t("courseActionOpen");
        statusText = t("courseStatusHasIssues", { count: progress.failed });
        needsAction = true;
      } else if (progress.total > 0) {
        actionLabel = t("courseActionComplete");
        statusText = t("courseStatusComplete");
      }
    }

    return {
      course,
      progress,
      verifiedPercent,
      actionLabel,
      actionDisabled,
      action,
      statusText,
      needsAction,
    };
  });
  const attention = summaries.filter((s) => s.needsAction);
  const summariesById = new Map(summaries.map((summary) => [summary.course.id, summary]));
  const featured: typeof summaries = [];
  const addFeatured = (summary: (typeof summaries)[number] | undefined) => {
    if (!summary || featured.some((item) => item.course.id === summary.course.id)) return;
    if (featured.length < 2) featured.push(summary);
  };
  attention.forEach(addFeatured);
  recentCourseIds.forEach((courseId) => addFeatured(summariesById.get(courseId)));
  summaries.filter((summary) => summary.progress?.nextReady).forEach(addFeatured);
  summaries.forEach(addFeatured);
  const featuredIds = new Set(featured.map((summary) => summary.course.id));
  const courseListSummaries = summaries.filter((summary) => !featuredIds.has(summary.course.id));
  const brand = t("brand");
  const almost = "(Almost)";
  const almostIndex = brand.indexOf(almost);
  const suggestedIdea = courseSuggestion.status === "ready" ? courseSuggestion.idea : null;
  const homeHeading = suggestedIdea?.topic || brand;
  const heroAction = onHomeTitleTap;
  const heroTitle = t("homeTitleTapHint");
  const momentumItems = homeMomentumItems(totals.verifiedAt, totals.verified, 0, uiLang, t);

  return (
    <div className="home-dashboard home-editorial">
      <div className="home-header">
        <div className="home-title-block">
          <div className="home-brand-lockup">
            <img className="home-brand-logo" src={appMark} alt="" aria-hidden="true" />
            <div>
              <div className="home-brand-eyebrow">{t("homeTitle")}</div>
              <div className="home-title-row">
                <h1>
                  <button
                    type="button"
                    className="home-title-button"
                    onClick={heroAction}
                    title={heroTitle}
                    aria-label={heroTitle}
                  >
                    {suggestedIdea ? (
                      <span className={homeTitleTextStyles.main}>{homeHeading}</span>
                    ) : almostIndex >= 0 ? (
                      <>
                        <span className={homeTitleTextStyles.main}>
                          {brand.slice(0, almostIndex)}
                        </span>
                        <span className={`home-brand-soft ${homeTitleTextStyles.almost}`}>
                          {almost}
                        </span>
                        <span className={homeTitleTextStyles.main}>
                          {brand.slice(almostIndex + almost.length)}
                        </span>
                      </>
                    ) : (
                      <span className={homeTitleTextStyles.main}>{brand}</span>
                    )}
                  </button>
                </h1>
                {courseSuggestion.status === "running" && (
                  <span className="spinner home-suggestion-spinner" title={t("homeSuggestionWorking")} />
                )}
                {courseSuggestion.status === "error" && (
                  <span className="home-suggestion-error" title={courseSuggestion.error}>
                    {t("homeSuggestionFailed")}
                  </span>
                )}
                {suggestedIdea && (
                  <button className="home-study-suggestion" onClick={onStudySuggestion}>
                    {t("studySuggestion")}
                  </button>
                )}
              </div>
            </div>
          </div>
          <HomeTagline />
        </div>
        <div className="home-header-actions">
          <button
            className="home-settings-action"
            onClick={onOpenSettings}
            title={t("settings")}
            aria-label={t("settings")}
          >
            <SettingsIcon />
            <span>{t("settings")}</span>
          </button>
          <button className="home-link-action" onClick={onOpenSpaces}>
            {t("spacesNav")}
          </button>
          <button className="home-link-action" onClick={onOpenCatalog}>
            {t("catalogOpen")}
          </button>
          <button className="home-primary" onClick={onNewCourse}>
            {t("newCourse")}
          </button>
        </div>
      </div>

      {courses.length > 0 && (
        <div className="home-momentum" aria-label={t("homeMomentumLabel")}>
          {momentumItems.map((item) => (
            <span className="home-momentum-item" key={item}>
              {item}
            </span>
          ))}
        </div>
      )}

      {courses.length > 0 && languageOptions.length > 1 && (
        <div className="home-language-filter" aria-label={t("homeLanguageFilterLabel")}>
          <span className="home-language-label">{t("homeLanguageFilterLabel")}</span>
          <div className="home-language-options">
            <button
              className={languageFilter === "all" ? "active" : ""}
              onClick={() => setLanguageFilter("all")}
              aria-pressed={languageFilter === "all"}
            >
              {t("homeLanguageAll")}
              <span>{courses.length}</span>
            </button>
            {languageOptions.map((option) => (
              <button
                key={option.code}
                className={languageFilter === option.code ? "active" : ""}
                onClick={() => setLanguageFilter(option.code)}
                aria-pressed={languageFilter === option.code}
              >
                {courseLanguageLabel(option.code, uiLang)}
                <span>{option.count}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <section className="home-spaces">
        <div className="home-spaces-head">
          <span className="home-section-kicker">{t("spacesTitle")}</span>
          <button className="home-link-action" onClick={onOpenSpaces}>
            {t("spacesManage")}
          </button>
        </div>
        <div className="home-spaces-row">
          {spaces.slice(0, 6).map((s) => (
            <button key={s.id} className="home-space-card" onClick={() => onOpenSpace(s.id)}>
              <span className="home-space-name">{s.name}</span>
              <span className="home-space-meta">
                {t("spaceSourceCount", { count: s.source_count })}
              </span>
            </button>
          ))}
          <button className="home-space-card home-space-new" onClick={onOpenSpaces}>
            <span className="home-space-name">+ {t("spaceCreate")}</span>
            <span className="home-space-meta">{t("spacesShortHint")}</span>
          </button>
        </div>
      </section>

      {courses.length === 0 ? (
        <div className="home-empty">
          <h2>{t("homeEmptyTitle")}</h2>
          <p>{t("homeEmptyBody")}</p>
          <button onClick={onNewCourse}>{t("newCourse")}</button>
        </div>
      ) : (
        <div className="home-paper-grid">
          <section className="home-featured">
            <div className="home-section-kicker">{t("homeFocusTitle")}</div>
            <div className="home-feature-list">
              {featured.map((summary) => (
                <article className="home-feature-card" key={summary.course.id}>
                  <button
                    className="home-feature-title"
                    onClick={summary.action}
                    disabled={summary.actionDisabled}
                  >
                    {courseTitle(summary.course, t("courseTitlePending"))}
                  </button>
                  <p className="home-card-progress-line">
                    {courseCardProgressLine(summary, uiLang, t)}
                  </p>
                  <div className="home-hairline-progress" aria-hidden="true">
                    <span style={{ width: `${summary.verifiedPercent}%` }} />
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="home-index">
            <div className="home-section-kicker">{t("homeCoursesTitle")}</div>
            <ol className="home-course-list">
              {courseListSummaries.map((summary) => (
                <li key={summary.course.id}>
                  <button onClick={() => onOpenCourse(summary.course.id)}>
                    {courseTitle(summary.course, t("courseTitlePending"))}
                  </button>
                  <span className="home-course-progress">{coursePositionLine(summary, t)}</span>
                  <span>{courseUnderstandingLine(summary, uiLang, t)}</span>
                  {courseGenerationLine(summary, t) && (
                    <span className="home-course-generation">
                      {courseGenerationLine(summary, t)}
                    </span>
                  )}
                </li>
              ))}
            </ol>
            {courseListSummaries.length === 0 && (
              <p className="home-index-empty">{t("homeNoOtherCourses")}</p>
            )}
          </section>
        </div>
      )}

      <HomeSystemStatus
        agentAvail={agentAvail}
        braveConfigured={braveConfigured}
        geminiConfigured={geminiConfigured}
        modelSettings={modelSettings}
        onOpenSettings={onOpenSettings}
      />
    </div>
  );
}

function HomeTagline() {
  const [lang] = useLang();
  const [index, setIndex] = useState(() => {
    const day = Math.floor(Date.now() / 86_400_000);
    return day % HOME_TAGLINES.length;
  });

  useEffect(() => {
    const timer = window.setInterval(() => {
      setIndex((value) => (value + 1) % HOME_TAGLINES.length);
    }, 18_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <p className="home-tagline" key={`${lang}-${index}`}>
      {HOME_TAGLINES[index][lang]}
    </p>
  );
}

function HomeSystemStatus({
  agentAvail,
  braveConfigured,
  geminiConfigured,
  modelSettings,
  onOpenSettings,
}: {
  agentAvail: AgentAvailability | null;
  braveConfigured: boolean | null;
  geminiConfigured: boolean | null;
  modelSettings: ModelConfig | null;
  onOpenSettings: () => void;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const hasAgent = Boolean(agentAvail?.claude || agentAvail?.codex);
  const coreReady = Boolean(hasAgent && braveConfigured === true && modelSettings);

  return (
    <footer className={`home-system-footer ${expanded ? "expanded" : ""}`}>
      <button
        type="button"
        className="home-system-toggle"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <span className={`home-status-dot ${coreReady ? "ok" : "warn"}`} />
        <span className="home-system-compact">
          <b>{coreReady ? t("homeSetupReady") : t("homeSetupNeedsAttention")}</b>
          <span>
            Claude {agentStatusText(agentAvail?.claude, t)} · Codex{" "}
            {agentStatusText(agentAvail?.codex, t)}
          </span>
          <span>
            {t("homeSearchService")} {configStatusText(braveConfigured, t)} ·{" "}
            {t("homeGeminiService")} {configStatusText(geminiConfigured, t)}
          </span>
        </span>
        <span className="home-system-chevron" aria-hidden="true">
          {expanded ? "−" : "+"}
        </span>
      </button>

      {expanded && (
        <div className="home-system-details">
          <div className="home-model-table" aria-label={t("homeSystemTitle")}>
            {(["claude", "codex"] as const).map((backend) => (
              <div
                className={`home-model-row ${agentAvail?.[backend] === false ? "disabled" : ""}`}
                key={backend}
              >
                <div className="home-model-backend">
                  <span>{backend === "claude" ? "Claude" : "Codex"}</span>
                  <span className={`home-status-dot ${agentAvail?.[backend] ? "ok" : "warn"}`} />
                </div>
                <div className="home-model-cells">
                  <span>{agentStatusText(agentAvail?.[backend], t)}</span>
                </div>
              </div>
            ))}
          </div>
          <button className="home-text-action muted" onClick={onOpenSettings}>
            {t("openSettings")}
          </button>
        </div>
      )}
    </footer>
  );
}

function agentStatusText(available: boolean | undefined, t: ReturnType<typeof useT>) {
  if (available === undefined) return t("homeChecking");
  return available ? t("agentAvailable") : t("agentUnavailable");
}

function configStatusText(configured: boolean | null, t: ReturnType<typeof useT>) {
  if (configured === null) return t("homeChecking");
  return configured ? t("homeConfigured") : t("homeNeedsSetup");
}

function courseLifecycleStatusLabel(status: string, t: ReturnType<typeof useT>) {
  if (status === "wizard") return t("statusWizard");
  if (status === "structuring") return t("statusStructuring");
  if (status === "ready") return t("statusReady");
  return status;
}

function coursePositionLine(
  summary: {
    progress?: CourseProgress;
    statusText: string;
  },
  t: ReturnType<typeof useT>
) {
  if (!summary.progress) return summary.statusText;
  if (summary.progress.total === 0) return summary.statusText;
  const pointer = summary.progress.nextReady ?? summary.progress.nextPending;
  return t("courseProgressPosition", {
    current: pointer?.index ?? summary.progress.total,
    total: summary.progress.total,
  });
}

function courseUnderstandingLine(
  summary: {
    progress?: CourseProgress;
    statusText: string;
  },
  lang: Lang,
  t: ReturnType<typeof useT>
) {
  if (!summary.progress) return summary.statusText;
  return `${t("courseProgressVerified", {
    topics: topicCount(summary.progress.verified, lang),
  })} · ${t("courseProgressReview", { count: summary.progress.reviewDue })}`;
}

function courseCardProgressLine(
  summary: {
    progress?: CourseProgress;
    statusText: string;
  },
  lang: Lang,
  t: ReturnType<typeof useT>
) {
  if (!summary.progress || summary.progress.total === 0) return summary.statusText;
  return [
    coursePositionLine(summary, t),
    courseUnderstandingLine(summary, lang, t),
  ]
    .filter(Boolean)
    .join(" · ");
}

function courseGenerationLine(
  summary: { progress?: CourseProgress },
  t: ReturnType<typeof useT>
) {
  const progress = summary.progress;
  if (!progress || progress.total === 0) return null;
  if (progress.generating > 0) {
    return t("courseGenerationWorking", { count: progress.generating });
  }
  if (progress.queued > 0) {
    return t("courseGenerationQueued", { count: progress.queued });
  }
  if (progress.failed > 0) {
    return t("courseGenerationFailed", { count: progress.failed });
  }
  if (progress.pending > 0) {
    return t("courseGenerationPending", { count: progress.pending });
  }
  return null;
}

function homeMomentumItems(
  verifiedAt: number[],
  verified: number,
  reviewDue: number,
  lang: Lang,
  t: ReturnType<typeof useT>
) {
  const undatedVerified = Math.max(0, verified - verifiedAt.length);
  const streak = Math.max(studyStreakDays(verifiedAt), undatedVerified > 0 ? 1 : 0);
  const weekChecks = checksThisWeek(verifiedAt) + undatedVerified;
  return [
    streak > 0 ? t("homeMomentumStreak", { count: streak }) : t("homeMomentumStartStreak"),
    weekChecks > 0
      ? t("homeMomentumWeekChecks", { tests: testCount(weekChecks, lang) })
      : t("homeMomentumFirstWeekCheck"),
    verified > 0
      ? t("homeMomentumVerified", { topics: topicCount(verified, lang) })
      : t("homeMomentumFirstVerified"),
    reviewDue > 0 ? t("homeMomentumReview", { count: reviewDue }) : t("homeMomentumReviewClear"),
  ];
}

function checksThisWeek(timestamps: number[]) {
  const start = new Date();
  const mondayOffset = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - mondayOffset);
  start.setHours(0, 0, 0, 0);
  const startMs = start.getTime();
  return timestamps.filter((ts) => ts * 1000 >= startMs).length;
}

function studyStreakDays(timestamps: number[]) {
  if (timestamps.length === 0) return 0;
  const days = new Set(timestamps.map((ts) => startOfLocalDay(ts * 1000)));
  const dayMs = 86_400_000;
  let cursor = startOfLocalDay(Date.now());
  if (!days.has(cursor)) cursor -= dayMs;
  let count = 0;
  while (days.has(cursor)) {
    count += 1;
    cursor -= dayMs;
  }
  return count;
}

function startOfLocalDay(ms: number) {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function topicCount(count: number, lang: Lang) {
  if (lang === "ru") return `${count} ${ruPlural(count, "тема", "темы", "тем")}`;
  return `${count} ${count === 1 ? "topic" : "topics"}`;
}

function testCount(count: number, lang: Lang) {
  if (lang === "ru") return `${count} ${ruPlural(count, "тест", "теста", "тестов")}`;
  return `${count} ${count === 1 ? "test" : "tests"}`;
}

function ruPlural(count: number, one: string, few: string, many: string) {
  const mod10 = Math.abs(count) % 10;
  const mod100 = Math.abs(count) % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
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

function readRecentCourseIds() {
  try {
    const raw = localStorage.getItem(RECENT_COURSES_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}
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

function AppUpdateSettingsPanel() {
  const t = useT();
  const updater = useAppUpdater(true);
  const installing = updater.phase === "downloading" || updater.phase === "restarting";
  const checking = updater.phase === "checking";
  const canInstall = updater.phase === "available" || updater.phase === "error";

  let status = t("appUpdateIdle");
  if (!isTauri) status = t("appUpdateUnsupported");
  else if (checking) status = t("appUpdateChecking");
  else if (updater.phase === "current") status = t("appUpdateCurrent");
  else if (updater.info && updater.phase === "available") {
    status = t("appUpdateAvailable", { version: updater.info.version });
  } else if (updater.phase === "downloading") {
    status = updateProgressLabel(t, updater);
  } else if (updater.phase === "restarting") {
    status = t("appUpdateRestarting");
  } else if (updater.error) {
    status = t("appUpdateError", { error: updater.error });
  }

  return (
    <div className="setting-group">
      <div className="setting-label">{t("appUpdateTitle")}</div>
      <div className="app-update-card">
        <div className="app-update-main">
          <div className="app-update-status">{status}</div>
          {updater.info && (
            <div className="setting-note">
              {t("appUpdateVersionLine", {
                current: updater.info.currentVersion,
                latest: updater.info.version,
              })}
            </div>
          )}
          {updater.phase === "downloading" && updater.progress !== null && (
            <div className="app-update-progress" aria-hidden="true">
              <div style={{ width: `${updater.progress}%` }} />
            </div>
          )}
        </div>
        <div className="app-update-actions">
          <button
            className="ghost"
            onClick={() => updater.checkForUpdate()}
            disabled={!isTauri || checking || installing}
          >
            {checking ? t("appUpdateChecking") : t("appUpdateCheck")}
          </button>
          {canInstall && updater.info && (
            <button onClick={updater.installAndRestart} disabled={installing}>
              {installing ? t("appUpdateInstalling") : t("appUpdateInstallRestart")}
            </button>
          )}
        </div>
      </div>
      <div className="setting-note">{t("appUpdateNote")}</div>
    </div>
  );
}

function SettingsModal({
  onClose,
  onDebugLoggingChange,
}: {
  onClose: () => void;
  onDebugLoggingChange: (enabled: boolean) => void;
}) {
  const t = useT();
  const [lang, setLang] = useLang();
  const [debugLogging, setDebugLogging] = useState(false);
  const [savingDebug, setSavingDebug] = useState(false);
  const [imageGeneration, setImageGeneration] = useState(true);
  const [savingImageGen, setSavingImageGen] = useState(false);
  const [braveKey, setBraveKey] = useState("");
  const [braveConfigured, setBraveConfigured] = useState(false);
  const [savingBrave, setSavingBrave] = useState(false);
  const [geminiKey, setGeminiKey] = useState("");
  const [geminiConfigured, setGeminiConfigured] = useState(false);
  const [savingGemini, setSavingGemini] = useState(false);
  const [catalogToken, setCatalogToken] = useState("");
  const [catalogTokenConfigured, setCatalogTokenConfigured] = useState(false);
  const [savingCatalogToken, setSavingCatalogToken] = useState(false);
  const [ttsEngine, setTtsEngine] = useState<"system" | "gemini">("system");
  const [ttsVoice, setTtsVoice] = useState("Kore");
  const [geminiImageModel, setGeminiImageModel] = useState("gemini-2.5-flash-image");
  const [geminiTtsModel, setGeminiTtsModel] = useState("gemini-2.5-flash-preview-tts");
  const [mcpServers, setMcpServers] = useState<McpServerStatus[]>([]);
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

  function applySettingsStatus(s: SettingsStatus) {
    setBraveConfigured(s.brave_configured);
    setGeminiConfigured(s.gemini_configured);
    setCatalogTokenConfigured(Boolean(s.catalog_upload_token_configured));
    setMcpServers(s.mcp_servers ?? []);
    setTtsEngine(s.tts_engine === "gemini" ? "gemini" : "system");
    if (s.tts_voice) setTtsVoice(s.tts_voice);
    if (s.gemini_image_model) setGeminiImageModel(s.gemini_image_model);
    if (s.gemini_tts_model) setGeminiTtsModel(s.gemini_tts_model);
    setDebugLogging(Boolean(s.debug_logging));
    setImageGeneration(s.image_generation !== false);
  }

  async function saveImageGeneration(enabled: boolean) {
    setSavingImageGen(true);
    try {
      await invoke("set_image_generation", { enabled });
      setImageGeneration(enabled);
    } catch {
      /* ignore */
    } finally {
      setSavingImageGen(false);
    }
  }

  async function saveDebugLogging(enabled: boolean) {
    setSavingDebug(true);
    try {
      await invoke("set_debug_logging", { enabled });
      setDebugLogging(enabled);
      onDebugLoggingChange(enabled);
    } catch {
      /* ignore */
    } finally {
      setSavingDebug(false);
    }
  }

  useEffect(() => {
    invoke<SettingsStatus>("get_settings_status")
      .then(applySettingsStatus)
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
      const s = await invoke<SettingsStatus>("set_brave_key", { key });
      applySettingsStatus(s);
      setBraveKey("");
    } finally {
      setSavingBrave(false);
    }
  }

  async function saveGemini(key: string | null) {
    setSavingGemini(true);
    try {
      const s = await invoke<SettingsStatus>("set_gemini_key", { key });
      applySettingsStatus(s);
      setGeminiKey("");
    } finally {
      setSavingGemini(false);
    }
  }

  async function saveCatalogToken(token: string | null) {
    setSavingCatalogToken(true);
    try {
      const s = await invoke<SettingsStatus>("set_catalog_upload_token", { token });
      applySettingsStatus(s);
      setCatalogToken("");
    } finally {
      setSavingCatalogToken(false);
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
          <label className="setting-toggle">
            <input
              type="checkbox"
              checked={debugLogging}
              disabled={savingDebug}
              onChange={(e) => saveDebugLogging(e.target.checked)}
            />
            <span className="setting-label">{t("debugLoggingLabel")}</span>
          </label>
          <div className="setting-note">{t("debugLoggingNote")}</div>
        </div>

        <AppUpdateSettingsPanel />

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
          <div className="setting-label">{t("catalogSettingsTitle")}</div>
          <div className="brave-row">
            <input
              type="password"
              className="custom-answer"
              value={catalogToken}
              placeholder={catalogTokenConfigured ? "•••••••••" : t("catalogTokenPlaceholder")}
              onChange={(e) => setCatalogToken(e.target.value)}
              disabled={savingCatalogToken}
            />
            <button
              onClick={() => saveCatalogToken(catalogToken)}
              disabled={!catalogToken.trim() || savingCatalogToken}
            >
              {t("braveSave")}
            </button>
            {catalogTokenConfigured && (
              <button
                className="ghost"
                onClick={() => saveCatalogToken(null)}
                disabled={savingCatalogToken}
              >
                {t("braveClear")}
              </button>
            )}
          </div>
          {catalogTokenConfigured && !catalogToken && (
            <div className="setting-note success-note">✓ {t("catalogTokenConfigured")}</div>
          )}
          <div className="setting-note">{t("catalogSettingsNote")}</div>
        </div>

        <div className="setting-group">
          <div className="setting-label">{t("mcpTitle")}</div>
          {mcpServers.length > 0 ? (
            <div className="mcp-list">
              {mcpServers.map((server) => (
                <div className="mcp-row" key={server.id}>
                  <div className="mcp-main">
                    <div className="mcp-name">{server.name}</div>
                    <div className="mcp-meta">
                      {server.enabled_for.join(" + ")} · {server.source}
                    </div>
                  </div>
                  <div className="mcp-tools">
                    {server.tools.map((tool) => (
                      <span className="mcp-tool" key={tool}>
                        {tool}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="setting-note">{t("mcpEmpty")}</div>
          )}
          <div className="setting-note">{t("mcpNote")}</div>
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
          <label className="setting-toggle">
            <input
              type="checkbox"
              checked={imageGeneration}
              disabled={savingImageGen}
              onChange={(e) => saveImageGeneration(e.target.checked)}
            />
            <span className="setting-label">{t("imageGenerationLabel")}</span>
          </label>
          <div className="setting-note">{t("imageGenerationNote")}</div>
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

function SpacesView({ onOpenSpace }: { onOpenSpace: (id: string) => void }) {
  const t = useT();
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);

  const reload = useCallback(async () => {
    try {
      setSpaces(await invoke<Space[]>("list_spaces"));
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || creating) return;
    setCreating(true);
    try {
      const space = await invoke<Space>("create_space", {
        name: name.trim(),
        description: description.trim() || null,
      });
      setName("");
      setDescription("");
      await reload();
      onOpenSpace(space.id);
    } catch {
      /* ignore */
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="spaces-view">
      <h2>{t("spacesTitle")}</h2>
      <p className="spaces-intro">{t("spacesIntro")}</p>

      <form className="space-create" onSubmit={create}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("spaceNamePlaceholder")}
        />
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t("spaceDescPlaceholder")}
        />
        <button type="submit" disabled={!name.trim() || creating}>
          {creating ? t("spaceCreating") : t("spaceCreate")}
        </button>
      </form>

      {loading ? (
        <div className="placeholder">{t("loadingStructure")}</div>
      ) : spaces.length === 0 ? (
        <div className="placeholder">{t("spacesEmpty")}</div>
      ) : (
        <ul className="space-list">
          {spaces.map((s) => (
            <li key={s.id} onClick={() => onOpenSpace(s.id)}>
              <div className="space-name">{s.name}</div>
              {s.description && <div className="space-desc">{s.description}</div>}
              <div className="space-meta">{t("spaceSourceCount", { count: s.source_count })}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const SOURCE_KIND_ICON: Record<string, string> = {
  site: "🌐",
  repo: "📦",
  directory: "📁",
  document: "📄",
  image: "🖼️",
  table: "📊",
};

function SpaceView({
  spaceId,
  onBack,
}: {
  spaceId: string;
  onBack: () => void;
}) {
  const t = useT();
  const [space, setSpace] = useState<Space | null>(null);
  const [sources, setSources] = useState<SpaceSource[]>([]);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkKind, setLinkKind] = useState<"site" | "repo">("site");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [converter, setConverter] = useState<{ available: boolean; via: string } | null>(null);
  const [installing, setInstalling] = useState(false);

  const checkConverter = useCallback(async () => {
    try {
      setConverter(await invoke<{ available: boolean; via: string }>("markitdown_status"));
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    checkConverter();
  }, [checkConverter]);

  async function installConverter() {
    if (installing) return;
    setInstalling(true);
    setError(null);
    try {
      await invoke<string>("install_markitdown");
      await checkConverter();
    } catch (e) {
      setError(String(e));
    } finally {
      setInstalling(false);
    }
  }

  const reload = useCallback(async () => {
    try {
      const [sp, src] = await Promise.all([
        invoke<Space | null>("get_space", { spaceId }),
        invoke<SpaceSource[]>("list_space_sources", { spaceId }),
      ]);
      setSpace(sp);
      setSources(src);
    } catch (e) {
      setError(String(e));
    }
  }, [spaceId]);

  useEffect(() => {
    reload();
  }, [reload]);
  // While a folder import converts documents in the background, keep refreshing.
  useEffect(() => {
    if (!sources.some((s) => s.status === "converting")) return;
    const id = setInterval(reload, 2500);
    return () => clearInterval(id);
  }, [sources, reload]);

  async function addLink(e: React.FormEvent) {
    e.preventDefault();
    if (!linkUrl.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await invoke("add_space_link", { spaceId, url: linkUrl.trim(), kind: linkKind });
      setLinkUrl("");
      await reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function uploadDocument() {
    if (busy) return;
    let picked: string | null = null;
    try {
      const sel = await openFileDialog({
        multiple: false,
        filters: [
          {
            name: t("spaceFileFilter"),
            extensions: ["pdf", "docx", "pptx", "xlsx", "xls", "csv", "html", "htm", "md", "txt", "png", "jpg", "jpeg", "webp", "gif"],
          },
        ],
      });
      picked = typeof sel === "string" ? sel : null;
    } catch (e) {
      setError(String(e));
      return;
    }
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      await invoke("add_space_document", { spaceId, filePath: picked });
      await reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function uploadDirectory() {
    if (busy) return;
    let picked: string | null = null;
    try {
      const sel = await openFileDialog({ directory: true, multiple: false });
      picked = typeof sel === "string" ? sel : null;
    } catch (e) {
      setError(String(e));
      return;
    }
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      await invoke("add_space_directory", { spaceId, dirPath: picked });
      await reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function removeSource(id: string) {
    try {
      await invoke("remove_space_source", { sourceId: id });
      await reload();
    } catch (e) {
      setError(String(e));
    }
  }

  async function deleteSpace() {
    try {
      await invoke("delete_space", { spaceId });
      onBack();
    } catch (e) {
      setError(String(e));
    }
  }

  if (!space) return <div className="placeholder">{t("loadingStructure")}</div>;

  return (
    <div className="space-detail">
      <div className="space-detail-head">
        <div>
          <h2>{space.name}</h2>
          {space.description && <p className="space-desc">{space.description}</p>}
        </div>
      </div>

      <div className="space-strict">
        <label className="setting-toggle">
          <input
            type="checkbox"
            checked={space.strict}
            onChange={async (e) => {
              const strict = e.target.checked;
              try {
                await invoke("set_space_strict", { spaceId, strict });
                setSpace((prev) => (prev ? { ...prev, strict } : prev));
              } catch (err) {
                setError(String(err));
              }
            }}
          />
          <span className="setting-label">{t("spaceStrictDefaultLabel")}</span>
        </label>
        <div className="setting-note">
          {space.strict ? t("spaceStrictDefaultOnNote") : t("spaceStrictDefaultOffNote")}
        </div>
      </div>

      <div className="space-add">
        <form className="space-add-link" onSubmit={addLink}>
          <select value={linkKind} onChange={(e) => setLinkKind(e.target.value as "site" | "repo")}>
            <option value="site">{t("spaceKindSite")}</option>
            <option value="repo">{t("spaceKindRepo")}</option>
          </select>
          <input
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            placeholder={t("spaceLinkPlaceholder")}
          />
          <button type="submit" disabled={!linkUrl.trim() || busy}>
            {t("spaceAddLink")}
          </button>
        </form>
        <button className="ghost" onClick={uploadDocument} disabled={busy}>
          {busy ? t("spaceUploading") : t("spaceUpload")}
        </button>
        <button className="ghost" onClick={uploadDirectory} disabled={busy}>
          {t("spaceAddFolder")}
        </button>
      </div>
      <div className="space-upload-note">{t("spaceUploadNote")}</div>

      {converter && !converter.available && (
        <div className="converter-banner">
          <span>{t("converterMissing")}</span>
          <button onClick={installConverter} disabled={installing}>
            {installing ? t("converterInstalling") : t("converterInstall")}
          </button>
        </div>
      )}

      {error && <p className="error-banner">{t("errorPrefix", { error })}</p>}

      {sources.length === 0 ? (
        <div className="placeholder">{t("spaceNoSources")}</div>
      ) : (
        <ul className="source-list">
          {sources.map((s) => (
            <li key={s.id} className={`source-item status-${s.status}`}>
              <span className="source-icon">{SOURCE_KIND_ICON[s.kind] ?? "📄"}</span>
              <div className="source-body">
                <div className="source-title">{s.title}</div>
                {(s.kind === "site" || s.kind === "repo" || s.kind === "directory") && (
                  <div className="source-ref">{s.ref}</div>
                )}
                {s.status === "failed" && s.error && (
                  <div className="source-error">{s.error}</div>
                )}
                {s.status === "converting" && (
                  <div className="source-ref">{t("spaceConverting")}</div>
                )}
              </div>
              <button
                className="source-remove"
                onClick={() => removeSource(s.id)}
                title={t("deleteConfirm")}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="course-danger-zone">
        {confirmDelete ? (
          <span className="delete-confirm-row">
            {t("spaceDeleteConfirm")}
            <button className="danger-link" onClick={deleteSpace}>
              {t("deleteConfirm")}
            </button>
            <button className="ghost" onClick={() => setConfirmDelete(false)}>
              {t("cancel")}
            </button>
          </span>
        ) : (
          <button className="danger-link" onClick={() => setConfirmDelete(true)}>
            {t("spaceDelete")}
          </button>
        )}
      </div>
    </div>
  );
}

function CreateCourse({
  agentAvail,
  spaceId,
  onCreated,
  onCancel,
}: {
  agentAvail: { claude: boolean; codex: boolean } | null;
  spaceId?: string;
  onCreated: (id: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [uiLang] = useLang();
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [selectedSpace, setSelectedSpace] = useState<string>(spaceId ?? "");
  const [strict, setStrict] = useState(true);

  useEffect(() => {
    invoke<Space[]>("list_spaces")
      .then(setSpaces)
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (spaceId) setSelectedSpace(spaceId);
  }, [spaceId]);
  // Default the strict choice from the selected space whenever it changes.
  useEffect(() => {
    if (!selectedSpace) return;
    const sp = spaces.find((s) => s.id === selectedSpace);
    if (sp) setStrict(sp.strict);
  }, [selectedSpace, spaces]);
  const initialAgent: Agent = agentAvail?.claude ? "claude" : agentAvail?.codex ? "codex" : "claude";
  const [topic, setTopic] = useState("");
  const [courseFormat, setCourseFormat] = useState<CourseFormat>(DEFAULT_COURSE_FORMAT);
  const [language, setLanguage] = useState(initialCourseLanguage);
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
    localStorage.setItem(COURSE_LANGUAGE_STORAGE_KEY, language);
    const id = await invoke<string>("create_course", {
      topic: topic.trim(),
      language,
      courseFormat,
      agent,
      spaceId: selectedSpace || null,
      strict: selectedSpace ? strict : null,
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
        {t("courseFormatLabel")}
        <div className="format-picker">
          {COURSE_FORMATS.map((item) => (
            <label
              key={item.value}
              className={`format-option ${courseFormat === item.value ? "selected" : ""}`}
            >
              <input
                type="radio"
                name="course-format"
                value={item.value}
                checked={courseFormat === item.value}
                onChange={() => setCourseFormat(item.value)}
              />
              <div className="format-meta">
                <div className="format-title">{t(item.titleKey)}</div>
                <div className="format-desc">{t(item.descKey)}</div>
              </div>
            </label>
          ))}
        </div>
        <span className="field-note">{t("courseFormatNote")}</span>
      </label>
      <label>
        {t("courseLanguageLabel")}
        <select
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
        >
          {COURSE_LANGUAGES.map((item) => (
            <option key={item.code} value={item.code}>
              {uiLang === "ru" ? item.nameRu : item.nameEn} · {item.nativeName} ·{" "}
              {item.code.toUpperCase()}
            </option>
          ))}
        </select>
        <span className="field-note">{t("courseLanguageNote")}</span>
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
      {(spaces.length > 0 || selectedSpace) && (
        <>
          <label>
            {t("spacePickLabel")}
            <select value={selectedSpace} onChange={(e) => setSelectedSpace(e.target.value)}>
              <option value="">{t("spaceNone")}</option>
              {spaces.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          {selectedSpace && (
            <label>
              {t("spaceStrictFieldLabel")}
              <select
                value={strict ? "strict" : "open"}
                onChange={(e) => setStrict(e.target.value === "strict")}
              >
                <option value="strict">{t("spaceStrictOptStrict")}</option>
                <option value="open">{t("spaceStrictOptOpen")}</option>
              </select>
              <div className="field-note">
                {strict ? t("spaceStrictOnNote") : t("spaceStrictOffNote")}
              </div>
            </label>
          )}
        </>
      )}
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

function CatalogView({ onImported }: { onImported: (courseId: string) => void | Promise<void> }) {
  const t = useT();
  const [items, setItems] = useState<CatalogCourse[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const loadSeq = useRef(0);

  const load = useCallback(async (nextQuery: string) => {
    const seq = loadSeq.current + 1;
    loadSeq.current = seq;
    setLoading(true);
    setError(null);
    try {
      const list = await invoke<CatalogCourse[]>("list_catalog_courses", {
        query: nextQuery.trim() || null,
      });
      if (seq !== loadSeq.current) return;
      setItems(list);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setError(String(e));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      load(query);
    }, 180);
    return () => window.clearTimeout(handle);
  }, [load, query]);

  async function download(item: CatalogCourse) {
    setDownloading(item.id);
    setError(null);
    try {
      const courseId = await invoke<string>("download_catalog_course", {
        catalogId: item.id,
      });
      await onImported(courseId);
    } catch (e) {
      setError(String(e));
      setDownloading(null);
    }
  }

  return (
    <div className="catalog-view">
      <div className="catalog-head">
        <div>
          <h2>{t("catalogTitle")}</h2>
          <p>{t("catalogSubtitle")}</p>
        </div>
        <button className="ghost" onClick={() => load(query)} disabled={loading}>
          {loading ? t("catalogLoading") : t("catalogRefresh")}
        </button>
      </div>
      <label className="catalog-search">
        <span>{t("catalogSearchLabel")}</span>
        <input
          value={query}
          placeholder={t("catalogSearchPlaceholder")}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      {error && <div className="error-banner">{t("errorPrefix", { error })}</div>}
      {loading && <div className="placeholder">{t("catalogLoading")}</div>}
      {!loading && items.length === 0 && (
        <div className="placeholder">
          {query.trim() ? t("catalogSearchEmpty") : t("catalogEmpty")}
        </div>
      )}
      <div className="catalog-list">
        {items.map((item) => (
          <article className="catalog-card" key={item.id}>
            <div className="catalog-card-main">
              <div className="catalog-card-title">{item.title}</div>
              <div className="catalog-card-topic">{item.topic}</div>
              <div className="catalog-card-meta">
                {item.language} · {t("catalogLessons", {
                  count: item.generated_lessons || item.lessons,
                })} · {t("catalogModules", { count: item.modules })}
              </div>
              {item.tags && item.tags.length > 0 && (
                <div className="catalog-card-tags">
                  {item.tags.slice(0, 6).map((tag) => (
                    <span key={tag}>{tag}</span>
                  ))}
                </div>
              )}
            </div>
            <div className="catalog-card-actions">
              <a href={item.view_url} target="_blank" rel="noreferrer">
                {t("catalogViewWeb")}
              </a>
              <button
                onClick={() => download(item)}
                disabled={downloading === item.id}
              >
                {downloading === item.id ? t("catalogDownloading") : t("catalogDownload")}
              </button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function CourseView({
  course,
  jobs,
  savedWizardQuestions,
  structureTranscript,
  onStartJob,
  onChanged,
  onOpenSub,
  onStartSubGen,
  onDeleted,
  onOpenCourse,
  translateStatus,
}: {
  course?: Course;
  jobs: Map<string, JobState>;
  savedWizardQuestions: Question[];
  structureTranscript: Bubble[] | null;
  onStartJob: (kind: JobKind) => void;
  onChanged: () => void | Promise<void>;
  onOpenSub: (moduleId: string, submoduleId: string) => void;
  onStartSubGen: (submoduleId: string) => void | Promise<void>;
  onDeleted: () => void | Promise<void>;
  onOpenCourse: (id: string) => void;
  translateStatus?: { done: number; total: number; complete: boolean };
}) {
  const t = useT();
  const [uiLang] = useLang();
  const [translateOpen, setTranslateOpen] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [publishUrl, setPublishUrl] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<CatalogUpdateStatus | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updatingCatalog, setUpdatingCatalog] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);

  const loadCatalogUpdate = useCallback(async () => {
    if (!course || course.status !== "ready") {
      setUpdateStatus(null);
      return;
    }
    setCheckingUpdate(true);
    setUpdateError(null);
    try {
      const status = await invoke<CatalogUpdateStatus>("get_catalog_update", {
        courseId: course.id,
      });
      setUpdateStatus(status);
    } catch (e) {
      setUpdateError(String(e));
    } finally {
      setCheckingUpdate(false);
    }
  }, [course]);

  useEffect(() => {
    loadCatalogUpdate();
  }, [loadCatalogUpdate]);

  if (!course) return <div className="placeholder">{t("courseNotFound")}</div>;

  async function publishCourse() {
    if (!course || publishing) return;
    setPublishing(true);
    setPublishError(null);
    setPublishUrl(null);
    try {
      const result = await invoke<{ id: string; url: string; version?: number }>("publish_course_to_catalog", {
        courseId: course.id,
      });
      setPublishUrl(result.url);
      await onChanged();
      await loadCatalogUpdate();
    } catch (e) {
      setPublishError(String(e));
    } finally {
      setPublishing(false);
    }
  }

  async function updateFromCatalog() {
    if (!course || updatingCatalog) return;
    setUpdatingCatalog(true);
    setUpdateError(null);
    try {
      await invoke<string>("update_catalog_course", { courseId: course.id });
      await onChanged();
      await loadCatalogUpdate();
    } catch (e) {
      setUpdateError(String(e));
    } finally {
      setUpdatingCatalog(false);
    }
  }

  async function translateCourse(lang: string) {
    if (!course || translating) return;
    setTranslating(true);
    try {
      const newId = await invoke<string>("translate_course", {
        courseId: course.id,
        targetLanguage: lang,
      });
      setTranslateOpen(false);
      await onChanged();
      onOpenCourse(newId);
    } catch (e) {
      console.error("translate_course failed", e);
    } finally {
      setTranslating(false);
    }
  }

  return (
    <div className="course-view">
      <CourseHeaderTitle course={course} />
      <div className="course-meta-full">
        <div className="course-meta-info">
          <span className="lang-pill">{course.language}</span>
          {categoryLabel(course.category, uiLang) && (
            <span className="category-pill">{categoryLabel(course.category, uiLang)}</span>
          )}
          <span className={`status-pill status-${course.status}`}>
            {courseLifecycleStatusLabel(course.status, t)}
          </span>
          {course.translated_from && (
            <span className="translated-badge">🌐 {t("translatedBadge")}</span>
          )}
        </div>
        <div className="course-meta-actions">
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
          <div className="translate-wrap">
            <button
              className="meta-action translate-btn"
              onClick={() => setTranslateOpen((v) => !v)}
              disabled={translating}
            >
              {translating ? t("translating") : t("translateButton")}
            </button>
            {translateOpen && (
              <div className="translate-menu">
                {COURSE_LANGUAGES.filter((l) => l.code !== course.language).map((l) => (
                  <button key={l.code} onClick={() => translateCourse(l.code)} disabled={translating}>
                    {l.nativeName}
                  </button>
                ))}
              </div>
            )}
          </div>
          {course.status === "ready" && (
            <button className="meta-action" onClick={publishCourse} disabled={publishing}>
              {publishing ? t("catalogPublishing") : t("catalogPublish")}
            </button>
          )}
        </div>
      </div>
      {(translateStatus ||
        (course.status === "ready" &&
          (publishUrl ||
            publishError ||
            checkingUpdate ||
            updateStatus?.available ||
            (updateStatus?.catalog_id && !updateStatus.available && !checkingUpdate) ||
            updateError))) && (
        <div className="course-status-area">
          {translateStatus && (
            <div className={`translate-status ${translateStatus.complete ? "done" : ""}`}>
              {translateStatus.complete
                ? `✓ ${t("translateDone")}`
                : t("translateProgress", {
                    done: translateStatus.done,
                    total: translateStatus.total,
                  })}
            </div>
          )}
          {course.status === "ready" &&
            (publishUrl ||
              publishError ||
              checkingUpdate ||
              updateStatus?.available ||
              (updateStatus?.catalog_id && !updateStatus.available && !checkingUpdate) ||
              updateError) && (
              <div className="catalog-status-row">
                {publishUrl && (
                  <a href={publishUrl} target="_blank" rel="noreferrer">
                    {t("catalogPublished")}
                  </a>
                )}
                {publishError && (
                  <span className="catalog-publish-error">
                    {t("errorPrefix", { error: publishError })}
                  </span>
                )}
                {checkingUpdate && <span>{t("catalogCheckingUpdate")}</span>}
                {updateStatus?.available && (
                  <button className="meta-action" onClick={updateFromCatalog} disabled={updatingCatalog}>
                    {updatingCatalog
                      ? t("catalogUpdating")
                      : t("catalogUpdateAvailable", {
                          count: updateStatus.remote_generated_lessons ?? 0,
                        })}
                  </button>
                )}
                {updateStatus?.catalog_id && !updateStatus.available && !checkingUpdate && (
                  <span>{t("catalogUpToDate")}</span>
                )}
                {updateError && (
                  <span className="catalog-publish-error">
                    {t("errorPrefix", { error: updateError })}
                  </span>
                )}
              </div>
            )}
        </div>
      )}
      {course.status === "wizard" && (
        <Wizard
          course={course}
          job={jobs.get(jobKey(course.id, "wizard_questions"))}
          savedQuestions={savedWizardQuestions}
          transcript={structureTranscript}
          onStart={() => onStartJob("wizard_questions")}
          onSaved={onChanged}
        />
      )}
      {course.status === "structuring" && (
        <StructureBuilder
          job={jobs.get(jobKey(course.id, "build_structure"))}
          course={course}
          transcript={structureTranscript}
          onStart={() => onStartJob("build_structure")}
          onSwitchAndRetry={async (agent) => {
            await invoke("set_course_agent", { courseId: course.id, agent });
            await onChanged();
            onStartJob("build_structure");
          }}
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

function CourseHeaderTitle({ course }: { course: Course }) {
  const t = useT();
  const title =
    course.title === undefined ? course.topic.trim() : course.title?.trim();
  if (title) return <h2>{title}</h2>;
  return (
    <div className="course-title-pending" role="status" aria-live="polite">
      <img
        className="course-title-loader"
        src={appLoader}
        alt=""
        aria-hidden="true"
        draggable={false}
      />
      <div className="course-title-pending-copy">
        <div className="course-title-pending-main">{t("courseTitlePendingReady")}</div>
        <div className="course-title-pending-sub">{t("courseTitlePendingEta")}</div>
      </div>
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
        <h2>{t("deleteCourseTitle", { topic: courseTitle(course, t("courseTitlePending")) })}</h2>
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
  savedQuestions,
  transcript,
  onStart,
  onSaved,
}: {
  course: Course;
  job?: JobState;
  savedQuestions: Question[];
  transcript: Bubble[] | null;
  onStart: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const t = useT();
  if (!job || (job.status === "done" && !job.result)) {
    if (savedQuestions.length > 0) {
      return <AnsweringForm course={course} questions={savedQuestions} onSaved={onSaved} />;
    }
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
        <AgentTranscript
          transcript={
            transcript?.length
              ? transcript
              : [{ kind: "running", text: t("wizardThinking") }]
          }
        />
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
  course,
  transcript,
  onStart,
  onSwitchAndRetry,
}: {
  job?: JobState;
  course: Course;
  transcript: Bubble[] | null;
  onStart: () => void;
  onSwitchAndRetry: (agent: string) => void;
}) {
  const t = useT();
  const running = job?.status === "running";
  const errored = job?.status === "error";
  const other = course.agent === "claude" ? "codex" : "claude";
  return (
    <div className="wizard">
      <p>{t("builderIntro")}</p>
      <button onClick={onStart} disabled={running}>
        {running ? t("buildingStructure") : t("generateStructure")}
      </button>
      {running && (
        <AgentTranscript
          transcript={
            transcript?.length
              ? transcript
              : [{ kind: "running", text: t("buildingStructure") }]
          }
        />
      )}
      {errored && (
        <div className="builder-error">
          <p style={{ color: "var(--danger)" }}>
            {t("errorPrefix", { error: (job as { error: string }).error })}
          </p>
          <p className="builder-error-hint">{t("structureFailedHint")}</p>
          <div className="builder-error-actions">
            <button onClick={onStart} disabled={running}>
              {t("retryButton")}
            </button>
            <button className="ghost" onClick={() => onSwitchAndRetry(other)} disabled={running}>
              {t("switchAgentRetry", { agent: other })}
            </button>
          </div>
        </div>
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
  const [startingFull, setStartingFull] = useState(false);

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
    setStartingFull(false);
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
      } else if (p.kind === "generate_submodule" || p.kind === "translate") {
        // Generation/translation progressed — pull fresh titles/state.
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

  const progress = summarizeStructure(tree);
  const canStartFull =
    progress.pending > 0 || (progress.queued > 0 && progress.generating === 0);

  async function startFullGeneration() {
    if (startingFull || !canStartFull) return;
    setStartingFull(true);
    try {
      await invoke("start_full_course_generation", { courseId: course.id });
      await reloadTree();
    } catch (e) {
      setError(String(e));
    } finally {
      setStartingFull(false);
    }
  }

  return (
    <div className="structure">
      {tree.modules.length === 0 ? (
        <div className="placeholder">{t("emptyStructure")}</div>
      ) : (
        <>
          <div className="structure-toolbar">
            <button
              type="button"
              onClick={startFullGeneration}
              disabled={startingFull || !canStartFull}
            >
              {startingFull || (!canStartFull && (progress.queued > 0 || progress.generating > 0))
                ? t("generateFullCourseBusy")
                : t("generateFullCourse")}
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => setShowRefine((v) => !v)}
              aria-expanded={showRefine}
            >
              {showRefine ? t("closeRefine") : t("refinePlanButton")}
            </button>
            {progress.queued > 0 && (
              <span className="toolbar-note">
                {t("fullCourseQueueStatus", { count: progress.queued })}
              </span>
            )}
          </div>
          <StructureTree
            tree={tree}
            onOpenSub={onOpenSub}
            onStartSubGen={async (subId) => {
              // Start (re)generation in the background — stay on the plan and
              // just refresh the row's state, don't jump to the lesson page.
              await onStartSubGen(subId);
              await reloadTree();
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
  const t = useT();
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
                        <span className="learned-dot" title={t("subLearned")}>
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
  if (state === "queued") {
    return (
      <button className="sub-action queued" disabled>
        {t("subQueued")}
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

type WidgetImageItem = {
  placeholder?: boolean;
  description?: string;
  prompt?: string;
  alt?: string;
  url?: string;
  source?: string;
  generated?: boolean;
};

type WidgetData =
  | ({ type: "image" } & WidgetImageItem)
  | { type: "gallery"; caption?: string; items?: WidgetImageItem[] }
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

type LightboxImage = {
  key: string;
  src: string;
  caption?: string;
  sourceHref?: string;
  generated?: boolean;
};

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

function countUnresolvedImageWidgets(widgets: Record<string, WidgetData>) {
  const isUnresolved = (item?: WidgetImageItem) => {
    if (!item) return true;
    const { imgSrc } = resolveWidgetImage(item.url, item.source);
    return item.placeholder === true || !imgSrc;
  };
  return Object.values(widgets ?? {}).reduce((count, widget) => {
    if (widget.type === "image") {
      return count + (isUnresolved(widget as WidgetImageItem) ? 1 : 0);
    }
    if (widget.type === "gallery") {
      const items = Array.isArray((widget as { items?: WidgetImageItem[] }).items)
        ? (widget as { items: WidgetImageItem[] }).items
        : [];
      return count + items.filter((item: WidgetImageItem) => isUnresolved(item)).length;
    }
    return count;
  }, 0);
}

type AssistantMsg = { role: "user" | "assistant"; text: string; fragment?: string; image?: string };
type Note = {
  id: string;
  courseId: string;
  moduleId: string;
  submoduleId: string;
  title: string;
  fragment?: string;
  messages: AssistantMsg[];
  created_at: number;
};

function CourseAssistant({
  courseId,
  moduleId,
  submoduleId,
  onOpenSubmodule,
}: {
  courseId: string;
  moduleId: string;
  submoduleId: string;
  onOpenSubmodule: (moduleId: string, submoduleId: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"chat" | "notes">("chat");
  const [messages, setMessages] = useState<AssistantMsg[]>([]);
  const [input, setInput] = useState("");
  const [fragment, setFragment] = useState<string | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<{ text: string; x: number; y: number } | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [saved, setSaved] = useState(false);
  const [currentNoteId, setCurrentNoteId] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  function newChat() {
    setMessages([]);
    setInput("");
    setFragment(null);
    setImage(null);
    setError(null);
    setCurrentNoteId(null);
    setMode("chat");
  }

  const loadNotes = useCallback(async () => {
    try {
      setNotes(await invoke<Note[]>("list_notes", { courseId }));
    } catch {
      /* ignore */
    }
  }, [courseId]);

  function highlightFragment(text?: string) {
    if (!text) return;
    const probe = text.replace(/…$/, "").slice(0, 80).trim();
    if (!probe) return;
    setTimeout(() => {
      try {
        (window as unknown as { find?: (s: string) => boolean }).find?.(probe);
      } catch {
        /* find unsupported */
      }
    }, 150);
  }

  function loadNote(note: Note) {
    setMessages(note.messages || []);
    setCurrentNoteId(note.id);
    setMode("chat");
    setOpen(true);
    if (note.fragment) highlightFragment(note.fragment);
  }

  function openNote(note: Note) {
    if (note.submoduleId === submoduleId) {
      loadNote(note);
    } else {
      try {
        localStorage.setItem(`pendingNote:${courseId}`, note.id);
      } catch {
        /* ignore */
      }
      onOpenSubmodule(note.moduleId, note.submoduleId);
    }
  }

  async function saveCurrentNote() {
    if (!messages.length) return;
    const firstQ = messages.find((m) => m.role === "user");
    const frag = messages.find((m) => m.fragment)?.fragment;
    const titleSrc = firstQ?.text || frag || t("notesUntitled");
    // Upsert: reuse this conversation's note id so saving again updates it
    // instead of creating a duplicate.
    const existing = currentNoteId ? notes.find((n) => n.id === currentNoteId) : undefined;
    const id = currentNoteId ?? crypto.randomUUID();
    const note: Note = {
      id,
      courseId,
      moduleId,
      submoduleId,
      title: titleSrc.replace(/\s+/g, " ").trim().slice(0, 70),
      fragment: frag,
      messages,
      created_at: existing?.created_at ?? Date.now(),
    };
    try {
      await invoke("save_note", { courseId, note });
      setCurrentNoteId(id);
      await loadNotes();
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setError(String(e));
    }
  }

  async function removeNote(id: string) {
    try {
      await invoke("delete_note", { courseId, noteId: id });
      await loadNotes();
    } catch {
      /* ignore */
    }
  }

  // On mount: load notes; if navigation left a pending note for this submodule,
  // open its conversation and highlight the original fragment.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const list = await invoke<Note[]>("list_notes", { courseId });
        if (!alive) return;
        setNotes(list);
        const pid = localStorage.getItem(`pendingNote:${courseId}`);
        if (pid) {
          localStorage.removeItem(`pendingNote:${courseId}`);
          const note = list.find((n) => n.id === pid && n.submoduleId === submoduleId);
          if (note) loadNote(note);
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId, submoduleId]);

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [messages, busy]);

  // Show a floating "ask about this" pill when text is selected in the article.
  useEffect(() => {
    function onMouseUp() {
      const s = window.getSelection?.();
      if (!s || s.isCollapsed) {
        setSel(null);
        return;
      }
      const text = s.toString().trim();
      let node: Node | null = s.anchorNode;
      let inReader = false;
      while (node) {
        if (node instanceof HTMLElement && node.classList?.contains("reader")) {
          inReader = true;
          break;
        }
        node = node.parentNode;
      }
      if (!text || !inReader) {
        setSel(null);
        return;
      }
      const rect = s.getRangeAt(0).getBoundingClientRect();
      setSel({
        text: text.length > 1500 ? text.slice(0, 1500) + "…" : text,
        x: rect.left + rect.width / 2,
        y: rect.top,
      });
    }
    function onMouseDown() {
      setSel(null);
    }
    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, []);

  function quoteSelection() {
    if (!sel) return;
    setFragment(sel.text);
    setOpen(true);
    setSel(null);
    window.getSelection?.()?.removeAllRanges();
  }

  async function attachImage() {
    try {
      const selFile = await openFileDialog({
        multiple: false,
        filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
      });
      if (typeof selFile === "string") setImage(selFile);
    } catch (e) {
      setError(String(e));
    }
  }

  async function send() {
    const q = input.trim();
    if ((!q && !image) || busy) return;
    const userMsg: AssistantMsg = {
      role: "user",
      text: q,
      fragment: fragment ?? undefined,
      image: image ?? undefined,
    };
    const history = messages.map((m) => ({ role: m.role, text: m.text }));
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setFragment(null);
    setImage(null);
    setBusy(true);
    setError(null);
    try {
      const answer = await invoke<string>("ask_course_assistant", {
        courseId,
        moduleId,
        submoduleId,
        question: q || "(see attached image)",
        fragment: userMsg.fragment ?? null,
        imagePath: userMsg.image ?? null,
        history,
      });
      setMessages((prev) => [...prev, { role: "assistant", text: answer || "…" }]);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {sel && !open && (
        <button
          className="assistant-quote"
          style={{ left: sel.x, top: sel.y }}
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onClick={quoteSelection}
        >
          💬 {t("assistantQuote")}
        </button>
      )}
      {!open && (
        <button className="assistant-fab" onClick={() => setOpen(true)} title={t("assistantTitle")}>
          <span className="assistant-fab-icon">💬</span>
          {t("assistantOpen")}
        </button>
      )}
      {open && (
        <div className="assistant-panel">
          <div className="assistant-head">
            <div className="assistant-tabs">
              <button
                className={mode === "chat" ? "active" : ""}
                onClick={() => setMode("chat")}
              >
                {t("assistantTabChat")}
              </button>
              <button
                className={mode === "notes" ? "active" : ""}
                onClick={() => {
                  setMode("notes");
                  loadNotes();
                }}
              >
                {t("assistantTabNotes")}
                {notes.length > 0 && <span className="assistant-tab-count">{notes.length}</span>}
              </button>
            </div>
            <div className="assistant-head-actions">
              {mode === "chat" && messages.length > 0 && (
                <>
                  <button className="assistant-save" onClick={newChat} title={t("notesNew")}>
                    ＋ {t("notesNew")}
                  </button>
                  <button
                    className="assistant-save"
                    onClick={saveCurrentNote}
                    title={t("notesSave")}
                  >
                    {saved
                      ? `✓ ${t("notesSaved")}`
                      : `★ ${currentNoteId ? t("notesUpdate") : t("notesSave")}`}
                  </button>
                </>
              )}
              <button className="assistant-close" onClick={() => setOpen(false)} aria-label="close">
                ✕
              </button>
            </div>
          </div>

          {mode === "notes" ? (
            <div className="assistant-body assistant-notes">
              {notes.length === 0 ? (
                <div className="assistant-empty">{t("notesEmpty")}</div>
              ) : (
                [...notes]
                  .sort((a, b) => b.created_at - a.created_at)
                  .map((n) => (
                    <div key={n.id} className="note-item">
                      <button className="note-open" onClick={() => openNote(n)}>
                        <span className="note-title">
                          {n.fragment ? "“ " : ""}
                          {n.title}
                        </span>
                        <span className="note-meta">
                          {new Date(n.created_at).toLocaleString()}
                          {n.submoduleId !== submoduleId ? ` · ${t("notesOtherSection")}` : ""}
                        </span>
                      </button>
                      <button
                        className="note-del"
                        onClick={() => removeNote(n.id)}
                        aria-label={t("deleteConfirm")}
                      >
                        ✕
                      </button>
                    </div>
                  ))
              )}
            </div>
          ) : (
            <>
              <div className="assistant-body" ref={bodyRef}>
                {messages.length === 0 && (
                  <div className="assistant-empty">{t("assistantHint")}</div>
                )}
                {messages.map((m, i) => (
                  <div key={i} className={`assistant-msg ${m.role}`}>
                    {m.fragment && <div className="assistant-frag">“{m.fragment}”</div>}
                    {m.role === "assistant" ? (
                      <div className="assistant-md reader">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm, remarkMath]}
                          rehypePlugins={[
                            rehypeKatex,
                            [rehypeHighlight, { detect: true, ignoreMissing: true }],
                          ]}
                        >
                          {m.text}
                        </ReactMarkdown>
                      </div>
                    ) : (
                      <div className="assistant-text">
                        {m.image && (
                          <img className="assistant-msg-img" src={convertFileSrc(m.image)} alt="" />
                        )}
                        {m.text}
                      </div>
                    )}
                  </div>
                ))}
                {busy && <div className="assistant-typing">{t("assistantThinking")}</div>}
              </div>
              {error && <div className="assistant-error">{t("errorPrefix", { error })}</div>}
              {fragment && (
                <div className="assistant-frag-chip">
                  <span>
                    “{fragment.slice(0, 90)}
                    {fragment.length > 90 ? "…" : ""}”
                  </span>
                  <button onClick={() => setFragment(null)} aria-label="remove">
                    ✕
                  </button>
                </div>
              )}
              {image && (
                <div className="assistant-img-chip">
                  <img src={convertFileSrc(image)} alt="" />
                  <span>{image.split("/").pop()}</span>
                  <button onClick={() => setImage(null)} aria-label="remove">
                    ✕
                  </button>
                </div>
              )}
              <div className="assistant-input">
                <button
                  className="assistant-attach"
                  onClick={attachImage}
                  title={t("assistantAttach")}
                  aria-label={t("assistantAttach")}
                >
                  📎
                </button>
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder={t("assistantPlaceholder")}
                  rows={3}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      send();
                    }
                  }}
                />
                <button
                  className="assistant-send"
                  onClick={send}
                  disabled={(!input.trim() && !image) || busy}
                  title={t("assistantSend")}
                  aria-label={t("assistantSend")}
                >
                  {busy ? "…" : "↑"}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}

function SubmoduleView({
  course,
  moduleId,
  submoduleId,
  stageDetail,
  transcript,
  lastError,
  enriching,
  onStartGen,
  onOpenSubmodule,
}: {
  course?: Course;
  moduleId: string;
  submoduleId: string;
  stageDetail: StageDetail | null;
  transcript: Bubble[] | null;
  lastError: string | null;
  enriching: boolean;
  onStartGen: (submoduleId: string) => void | Promise<void>;
  onOpenSubmodule: (moduleId: string, submoduleId: string) => void;
}) {
  const t = useT();
  const [tree, setTree] = useState<StructureFile | null>(null);
  const [content, setContent] = useState<SubmoduleContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingRegen, setConfirmingRegen] = useState(false);
  const [savedError, setSavedError] = useState<string | null>(null);
  const [retryingImages, setRetryingImages] = useState(false);
  const [imageRetryError, setImageRetryError] = useState<string | null>(null);
  const [canGenerate, setCanGenerate] = useState(false);
  useEffect(() => {
    if (!course) return;
    invoke<boolean>("image_generation_available", { courseId: course.id })
      .then(setCanGenerate)
      .catch(() => setCanGenerate(false));
  }, [course]);
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
    setRetryingImages(false);
    setImageRetryError(null);
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
        setRetryingImages(false);
        setImageRetryError(null);
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
  const isPodcast = course.course_format === "podcast_series";
  const unresolvedImages = !isPodcast && content ? countUnresolvedImageWidgets(content.widgets) : 0;

  async function retryImages() {
    if (!course) return;
    setRetryingImages(true);
    setImageRetryError(null);
    try {
      await invoke("start_illustrate_submodule", {
        courseId: course.id,
        moduleId,
        submoduleId,
      });
    } catch (e) {
      setRetryingImages(false);
      setImageRetryError(String(e));
    }
  }

  return (
    <div className="submodule-view">
      {course && (
        <CourseAssistant
          courseId={course.id}
          moduleId={moduleId}
          submoduleId={submoduleId}
          onOpenSubmodule={onOpenSubmodule}
        />
      )}
      <div className="sub-numbering">
        {moduleIdx + 1}.{subIdx + 1}
        {sub.test_passed && <span className="learned-badge">✓ {t("subLearned")}</span>}
      </div>
      <h1 className="sub-h1">{sub.title}</h1>
      {sub.summary && <div className="sub-lead">{sub.summary}</div>}

      {(state === "pending" || state === "queued" || state === "failed") && (
        <div className="sub-empty">
          <p>
            {state === "failed"
              ? t("stageFailedHint")
              : state === "queued"
                ? t("stageQueuedHint")
                : t("stagePendingHint")}
          </p>
          {state === "failed" && (lastError || savedError) && (
            <pre className="sub-error">{lastError || savedError}</pre>
          )}
          {state === "queued" ? (
            <button disabled>{t("subQueued")}</button>
          ) : (
            <button
              onClick={async () => {
                await onStartGen(submoduleId);
                await reloadTree();
              }}
            >
              {state === "failed" ? t("subContinue") : t("subGenerate")}
            </button>
          )}
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
              {!enriching && unresolvedImages > 0 && (
                <div className="sub-recovery">
                  <div>
                    <div className="sub-recovery-title">
                      {t("subImagesIncomplete", { count: unresolvedImages })}
                    </div>
                    <div className="sub-recovery-body">{t("subImagesIncompleteBody")}</div>
                    {imageRetryError && (
                      <div className="sub-recovery-error">
                        {t("errorPrefix", { error: imageRetryError })}
                      </div>
                    )}
                  </div>
                  <button
                    className="sub-recovery-action"
                    disabled={retryingImages}
                    onClick={retryImages}
                  >
                    {retryingImages ? (
                      <>
                        <span className="spinner" /> {t("subImagesRetrying")}
                      </>
                    ) : (
                      t("subImagesRetry")
                    )}
                  </button>
                </div>
              )}
              <ArticleReader
                article={isPodcast ? stripArticleWidgetMarkers(content.article) : content.article}
                widgets={isPodcast ? {} : content.widgets}
                fontPx={fontPx}
                widgetCtx={
                  course && !isPodcast
                    ? {
                        courseId: course.id,
                        moduleId,
                        submoduleId,
                        canGenerate,
                        onChanged: reloadContent,
                      }
                    : undefined
                }
              />
              {content.sources?.length > 0 && (
                <SourcesList sources={content.sources} />
              )}
              {!isPodcast && content.test?.length > 0 && (
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
              {!isPodcast && (
                <AssignmentsSection
                  courseId={course.id}
                  moduleId={moduleId}
                  submoduleId={submoduleId}
                />
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

function stripArticleWidgetMarkers(md: string): string {
  return (md || "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("::widget{"))
    .join("\n");
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

type StickyDock = "full" | "left" | "right";
type StickyDrag = {
  pointerId: number;
  startX: number;
  startY: number;
  dx: number;
  dy: number;
  dragging: boolean;
  originDock: StickyDock;
};

const STICKY_DRAG_START_PX = 6;
const STICKY_COLLAPSE_PX = 84;
const STICKY_RESTORE_BOTTOM_PX = 190;
const STICKY_RESTORE_CENTER_PX = 120;

function mobileStickyGestureEnabled() {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 720px)").matches;
}

function StickyPlayer() {
  const t = useT();
  const p = useAudioPlayer();
  const s = p.state;
  const [dock, setDock] = useState<StickyDock>("full");
  const [drag, setDrag] = useState<StickyDrag | null>(null);
  const suppressDockClickRef = useRef(false);
  const hasScrubber = s.engine === "gemini" && s.duration > 0;
  const pct = hasScrubber ? Math.min(100, (s.currentTime / s.duration) * 100) : 0;

  const isDocked = dock !== "full";
  const stickyClass = [
    "audio-sticky",
    isDocked ? "audio-sticky--docked" : "",
    dock === "left" ? "audio-sticky--docked-left" : "",
    dock === "right" ? "audio-sticky--docked-right" : "",
    drag?.dragging ? "audio-sticky--dragging" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const dragStyle = drag
    ? ({
        "--audio-drag-x": `${drag.dx}px`,
        "--audio-drag-y": `${drag.dy}px`,
      } as CSSProperties)
    : undefined;

  const startGesture = useCallback((clientX: number, clientY: number, originDock: StickyDock, pointerId = -1) => {
    setDrag({
      pointerId,
      startX: clientX,
      startY: clientY,
      dx: 0,
      dy: 0,
      dragging: false,
      originDock,
    });
  }, []);

  const updateGesture = useCallback((clientX: number, clientY: number, pointerId?: number) => {
    setDrag((cur) => {
      if (!cur || (pointerId !== undefined && cur.pointerId !== pointerId)) return cur;
      const dx = clientX - cur.startX;
      const dy = clientY - cur.startY;
      return {
        ...cur,
        dx,
        dy,
        dragging: cur.dragging || Math.hypot(dx, dy) > STICKY_DRAG_START_PX,
      };
    });
  }, []);

  const finishGestureAt = useCallback((clientX: number, clientY: number, pointerId?: number) => {
    setDrag((cur) => {
      if (!cur || (pointerId !== undefined && cur.pointerId !== pointerId)) return cur;
      const nearBottom = clientY > window.innerHeight - STICKY_RESTORE_BOTTOM_PX;
      const nearCenter =
        Math.abs(clientX - window.innerWidth / 2) < STICKY_RESTORE_CENTER_PX;
      const shouldRestore = cur.originDock !== "full" && nearBottom && nearCenter;

      if (cur.dragging || shouldRestore) {
        suppressDockClickRef.current = true;
        window.setTimeout(() => {
          suppressDockClickRef.current = false;
        }, 80);
      }

      if (cur.originDock === "full") {
        const mostlyHorizontal = Math.abs(cur.dx) > Math.abs(cur.dy) * 1.1;
        if (cur.dragging && mostlyHorizontal && Math.abs(cur.dx) > STICKY_COLLAPSE_PX) {
          setDock(cur.dx < 0 ? "left" : "right");
        }
      } else if (shouldRestore) {
        setDock("full");
      } else if (cur.dragging && Math.abs(cur.dx) > STICKY_COLLAPSE_PX) {
        setDock(clientX < window.innerWidth / 2 ? "left" : "right");
      }

      return null;
    });
  }, []);

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (!mobileStickyGestureEnabled() || e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (dock === "full" && target.closest("button,input")) return;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {}
      startGesture(e.clientX, e.clientY, dock, e.pointerId);
    },
    [dock, startGesture]
  );

  const handlePointerMove = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    updateGesture(e.clientX, e.clientY, e.pointerId);
  }, [updateGesture]);

  const finishPointerGesture = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    finishGestureAt(e.clientX, e.clientY, e.pointerId);
  }, [finishGestureAt]);

  const handleMouseDown = useCallback(
    (e: ReactMouseEvent<HTMLElement>) => {
      if (!mobileStickyGestureEnabled() || e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (dock === "full" && target.closest("button,input")) return;
      startGesture(e.clientX, e.clientY, dock);
      const handleWindowMouseMove = (event: MouseEvent) => {
        updateGesture(event.clientX, event.clientY);
      };
      const handleWindowMouseUp = (event: MouseEvent) => {
        window.removeEventListener("mousemove", handleWindowMouseMove);
        finishGestureAt(event.clientX, event.clientY);
      };
      window.addEventListener("mousemove", handleWindowMouseMove);
      window.addEventListener("mouseup", handleWindowMouseUp, { once: true });
    },
    [dock, finishGestureAt, startGesture, updateGesture]
  );

  const handleDockPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      handlePointerDown(e);
    },
    [handlePointerDown]
  );

  const handleDockPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      handlePointerMove(e);
    },
    [handlePointerMove]
  );

  const finishDockPointerGesture = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      finishPointerGesture(e);
    },
    [finishPointerGesture]
  );

  const handleDockMouseDown = useCallback(
    (e: ReactMouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      handleMouseDown(e);
    },
    [handleMouseDown]
  );

  const handleDockButtonClick = useCallback(
    (e: ReactMouseEvent<HTMLButtonElement>) => {
      if (suppressDockClickRef.current) {
        e.preventDefault();
        return;
      }
      if (s.preparing) return;
      if (s.mode === "paused") p.resume();
      else p.pause();
    },
    [p, s.mode, s.preparing]
  );

  if (isDocked) {
    const dockLabel = s.preparing
      ? t("lecturePreparing")
      : s.mode === "paused"
        ? t("lectureResume")
        : t("lecturePause");
    return (
      <div
        className={stickyClass}
        style={dragStyle}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishPointerGesture}
        onPointerCancel={finishPointerGesture}
        onMouseDown={handleMouseDown}
      >
        <button
          className="audio-dock-button"
          onPointerDown={handleDockPointerDown}
          onPointerMove={handleDockPointerMove}
          onPointerUp={finishDockPointerGesture}
          onPointerCancel={finishDockPointerGesture}
          onMouseDown={handleDockMouseDown}
          onClick={handleDockButtonClick}
          aria-label={dockLabel}
          title={dockLabel}
        >
          {s.preparing ? <span className="spinner" /> : s.mode === "paused" ? "▶" : "⏸"}
        </button>
      </div>
    );
  }

  return (
    <div
      className={stickyClass}
      style={dragStyle}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishPointerGesture}
      onPointerCancel={finishPointerGesture}
      onMouseDown={handleMouseDown}
    >
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
            aria-label={t("audioSeek")}
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
                aria-label={t("audioSeek")}
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

type WidgetCtx = {
  courseId: string;
  moduleId: string;
  submoduleId: string;
  canGenerate: boolean;
  onChanged: () => void | Promise<void>;
};

function CodeBlock({ children, className }: { children?: ReactNode; className?: string }) {
  const t = useT();
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  async function copy() {
    const text = preRef.current?.innerText ?? "";
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }
  return (
    <div className="code-block">
      <button type="button" className="code-copy" onClick={copy} aria-label={t("copyCode")}>
        {copied ? t("copied") : t("copy")}
      </button>
      <pre ref={preRef} className={className}>
        {children}
      </pre>
    </div>
  );
}

function ArticleReader({
  article,
  widgets,
  fontPx,
  widgetCtx,
}: {
  article: string;
  widgets: Record<string, WidgetData>;
  fontPx: number;
  widgetCtx?: WidgetCtx;
}) {
  const parts = useMemo(() => splitWidgetMarkers(article), [article]);
  const lightboxImages = useMemo(
    () => collectLightboxImages(parts, widgets),
    [parts, widgets]
  );
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const openLightboxImage = useCallback(
    (key: string) => {
      const index = lightboxImages.findIndex((image) => image.key === key);
      if (index >= 0) setLightboxIndex(index);
    },
    [lightboxImages]
  );
  const moveLightbox = useCallback(
    (delta: number) => {
      setLightboxIndex((index) => {
        if (index === null || lightboxImages.length === 0) return index;
        return (index + delta + lightboxImages.length) % lightboxImages.length;
      });
    },
    [lightboxImages.length]
  );

  useEffect(() => {
    if (lightboxIndex !== null && lightboxIndex >= lightboxImages.length) {
      setLightboxIndex(null);
    }
  }, [lightboxImages.length, lightboxIndex]);

  return (
    <article className="reader" style={{ ["--reader-font" as string]: `${fontPx}px` }}>
      {parts.map((p, i) =>
        p.kind === "md" ? (
          <ReactMarkdown
            key={i}
            remarkPlugins={[remarkGfm, remarkMath]}
            rehypePlugins={[rehypeKatex, [rehypeHighlight, { detect: true, ignoreMissing: true }]]}
            components={{ pre: CodeBlock }}
          >
            {p.text}
          </ReactMarkdown>
        ) : (
          <WidgetRenderer
            key={i}
            id={p.id}
            widget={widgets[p.id]}
            onOpenImage={openLightboxImage}
            widgetCtx={widgetCtx}
          />
        )
      )}
      {lightboxIndex !== null && lightboxImages[lightboxIndex] && (
        <ImageLightbox
          images={lightboxImages}
          index={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onMove={moveLightbox}
        />
      )}
    </article>
  );
}

function collectLightboxImages(
  parts: Array<{ kind: "md"; text: string } | { kind: "widget"; id: string }>,
  widgets: Record<string, WidgetData>
) {
  const images: LightboxImage[] = [];
  const addImage = (key: string, item: WidgetImageItem) => {
    const { hasUrl, imgSrc } = resolveWidgetImage(item.url, item.source);
    if (!hasUrl || !imgSrc) return;
    images.push({
      key,
      src: imgSrc,
      caption: item.description,
      sourceHref: widgetImageSourceHref(item),
      generated: item.generated,
    });
  };

  for (const part of parts) {
    if (part.kind !== "widget") continue;
    const widget = widgets[part.id];
    if (!widget) continue;
    if (widget.type === "image") {
      addImage(part.id, widget as WidgetImageItem);
    } else if (widget.type === "gallery") {
      const items = Array.isArray((widget as { items?: WidgetImageItem[] }).items)
        ? (widget as { items: WidgetImageItem[] }).items
        : [];
      items.forEach((item, index) => addImage(`${part.id}-${index}`, item));
    }
  }
  return images;
}

function WidgetRenderer({
  id,
  widget,
  onOpenImage,
  widgetCtx,
}: {
  id: string;
  widget?: WidgetData;
  onOpenImage?: (key: string) => void;
  widgetCtx?: WidgetCtx;
}) {
  const t = useT();
  if (!widget) {
    return (
      <div className="widget widget-unknown">
        {t("widgetUnknown")} <span className="widget-id">#{id}</span>
      </div>
    );
  }
  if (widget.type === "image") {
    return (
      <ImagePlaceholder
        id={id}
        widget={widget as any}
        onOpenImage={onOpenImage}
        widgetCtx={widgetCtx}
      />
    );
  }
  if (widget.type === "gallery") {
    return <GalleryWidget id={id} widget={widget as any} onOpenImage={onOpenImage} />;
  }
  if (widget.type === "diagram") return <DiagramWidget id={id} widget={widget as any} />;
  if (widget.type === "video") return <VideoWidget id={id} widget={widget as any} />;
  if (widget.type === "interactive") return <InteractiveWidget id={id} widget={widget as any} />;
  return (
    <div className="widget widget-unknown">
      {t("widgetUnknown")}: {widget.type} <span className="widget-id">#{id}</span>
    </div>
  );
}

const WIKIMEDIA_THUMB_STEPS = [20, 40, 60, 120, 250, 330, 500, 960, 1280, 1920, 3840];

function isBlockedWikimediaThumbnail(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "upload.wikimedia.org") return false;
    if (!parsed.pathname.includes("/thumb/")) return false;
    const file = parsed.pathname.split("/").pop() ?? "";
    const match = file.match(/^(\d+)px-/);
    if (!match) return false;
    return !WIKIMEDIA_THUMB_STEPS.includes(Number(match[1]));
  } catch {
    return false;
  }
}

function resolveWidgetImage(url?: string, source?: string) {
  const hasUrl = typeof url === "string" && url.length > 0;
  const isLocal = hasUrl && (url!.startsWith("/") || url!.startsWith("file://"));
  const blockedRemote = hasUrl && !isLocal && isBlockedWikimediaThumbnail(url!);
  const imgSrc = !hasUrl || blockedRemote
    ? ""
    : isLocal
      ? convertFileSrc(url!.replace(/^file:\/\//, ""))
      : url!;
  const linkHref = source || (isLocal ? imgSrc : url);
  return { hasUrl, imgSrc, linkHref };
}

function widgetImageSourceHref(item: WidgetImageItem) {
  if (item.source) return item.source;
  if (!item.url || item.generated) return undefined;
  if (item.url.startsWith("/") || item.url.startsWith("file://")) return undefined;
  return item.url;
}

function ImageCaption({
  description,
  generated,
  sourceHref,
  className,
}: {
  description?: string;
  generated?: boolean;
  sourceHref?: string;
  className?: string;
}) {
  const t = useT();
  if (!description && !generated && !sourceHref) return null;
  return (
    <figcaption className={className}>
      {(description || generated) && (
        <div>
          {description}
          {generated && (
            <span className="widget-generated">
              {description ? " · " : ""}
              🪄 {t("imgGenerated")}
            </span>
          )}
        </div>
      )}
      {sourceHref && (
        <a
          className="widget-image-source"
          href={sourceHref}
          target="_blank"
          rel="noreferrer"
        >
          {t("widgetImageSource")} · {hostnameOf(sourceHref)}
        </a>
      )}
    </figcaption>
  );
}

function ImageLightbox({
  images,
  index,
  onClose,
  onMove,
}: {
  images: LightboxImage[];
  index: number;
  onClose: () => void;
  onMove: (delta: number) => void;
}) {
  const t = useT();
  const image = images[index];
  const hasMany = images.length > 1;

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      else if (event.key === "ArrowLeft" && hasMany) onMove(-1);
      else if (event.key === "ArrowRight" && hasMany) onMove(1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [hasMany, onClose, onMove]);

  return (
    <div
      className="image-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={t("widgetImageOpen")}
      onClick={onClose}
    >
      <div className="image-lightbox-stage" onClick={(event) => event.stopPropagation()}>
        <button
          type="button"
          className="image-lightbox-close"
          onClick={onClose}
          aria-label={t("widgetImageLightboxClose")}
        >
          {t("widgetImageLightboxClose")}
        </button>
        <div className="image-lightbox-media">
          {hasMany && (
            <button
              type="button"
              className="image-lightbox-nav prev"
              onClick={() => onMove(-1)}
              aria-label={t("widgetImageLightboxPrev")}
            >
              {"<"}
            </button>
          )}
          <img src={image.src} alt={image.caption || ""} />
          {hasMany && (
            <button
              type="button"
              className="image-lightbox-nav next"
              onClick={() => onMove(1)}
              aria-label={t("widgetImageLightboxNext")}
            >
              {">"}
            </button>
          )}
        </div>
        {(image.caption || image.generated || image.sourceHref) && (
          <div className="image-lightbox-caption">
            {(image.caption || image.generated) && (
              <div>
                {image.caption}
                {image.generated && (
                  <span className="widget-generated">
                    {image.caption ? " · " : ""}
                    🪄 {t("imgGenerated")}
                  </span>
                )}
              </div>
            )}
            {image.sourceHref && (
              <a href={image.sourceHref} target="_blank" rel="noreferrer">
                {t("widgetImageSource")} · {hostnameOf(image.sourceHref)}
              </a>
            )}
            {hasMany && (
              <div className="image-lightbox-count">
                {index + 1} / {images.length}
              </div>
            )}
          </div>
        )}
      </div>
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
            // YouTube returns "Error 153" when the embed gets no acceptable HTTP
            // Referer (the app's custom-scheme origin). Force the origin to be
            // sent so the player loads inside the webview.
            referrerPolicy="strict-origin-when-cross-origin"
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
        {embed && (
          <a className="widget-video-open" href={widget.url} target="_blank" rel="noreferrer">
            {t("widgetVideoOpen")} ↗
          </a>
        )}
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

function GalleryWidget({
  id,
  widget,
  onOpenImage,
}: {
  id: string;
  widget: { caption?: string; items?: WidgetImageItem[] };
  onOpenImage?: (key: string) => void;
}) {
  const t = useT();
  const items = Array.isArray(widget.items) ? widget.items : [];
  const [failed, setFailed] = useState<Set<number>>(new Set());

  useEffect(() => {
    setFailed(new Set());
  }, [widget.items]);

  if (items.length === 0) {
    return (
      <figure className="widget widget-gallery">
        <div className="widget-image-box">
          <span className="widget-label">{t("widgetGallery")}</span>
          <span className="widget-id">#{id}</span>
        </div>
      </figure>
    );
  }

  return (
    <figure className="widget widget-gallery">
      <div className="widget-gallery-grid">
        {items.map((item, index) => {
          const { hasUrl, imgSrc } = resolveWidgetImage(item.url, item.source);
          const unavailable = hasUrl && (!imgSrc || failed.has(index));
          const imageKey = `${id}-${index}`;
          const sourceHref = widgetImageSourceHref(item);
          return (
            <div className="widget-gallery-item" key={`${id}-${index}`}>
              {hasUrl && imgSrc && !failed.has(index) ? (
                <button
                  type="button"
                  className="widget-image-link"
                  onClick={() => onOpenImage?.(imageKey)}
                  aria-label={t("widgetImageOpen")}
                  title={t("widgetImageOpen")}
                >
                  <img
                    src={imgSrc}
                    alt={item.alt || ""}
                    className="widget-image-real"
                    onError={() =>
                      setFailed((prev) => {
                        const next = new Set(prev);
                        next.add(index);
                        return next;
                      })
                    }
                  />
                </button>
              ) : (
                <div className={`widget-image-box ${unavailable ? "widget-image-error" : ""}`}>
                  <span className="widget-label">
                    {unavailable ? t("widgetImageUnavailable") : t("widgetImage")}
                  </span>
                  <span className="widget-id">#{id}.{index + 1}</span>
                </div>
              )}
              <ImageCaption
                className="widget-gallery-caption"
                description={item.description}
                generated={item.generated}
                sourceHref={sourceHref}
              />
            </div>
          );
        })}
      </div>
      {widget.caption && <figcaption>{widget.caption}</figcaption>}
    </figure>
  );
}

type ImageCandidate = { url: string; source: string; title: string; thumbnail: string };

function ImagePlaceholder({
  id,
  widget,
  onOpenImage,
  widgetCtx,
}: {
  id: string;
  widget: {
    description?: string;
    alt?: string;
    url?: string;
    source?: string;
    generated?: boolean;
  };
  onOpenImage?: (key: string) => void;
  widgetCtx?: WidgetCtx;
}) {
  const t = useT();
  const [imageFailed, setImageFailed] = useState(false);
  const { hasUrl, imgSrc } = resolveWidgetImage(widget.url, widget.source);
  const sourceHref = widgetImageSourceHref(widget);
  const [phase, setPhase] = useState<"idle" | "searching" | "picking" | "notfound" | "busy">(
    "idle"
  );
  const [candidates, setCandidates] = useState<ImageCandidate[]>([]);
  const [preview, setPreview] = useState<ImageCandidate | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  useEffect(() => {
    setImageFailed(false);
  }, [imgSrc]);

  const ctxArgs = widgetCtx
    ? {
        courseId: widgetCtx.courseId,
        moduleId: widgetCtx.moduleId,
        submoduleId: widgetCtx.submoduleId,
        widgetId: id,
      }
    : null;

  async function retry() {
    if (!ctxArgs) return;
    setPhase("searching");
    setActionError(null);
    try {
      const cands = await invoke<ImageCandidate[]>("search_widget_candidates", ctxArgs);
      if (cands.length) {
        setCandidates(cands);
        setPhase("picking");
      } else {
        setPhase("notfound");
      }
    } catch (e) {
      setActionError(String(e));
      setPhase("notfound");
    }
  }
  async function pick(c: ImageCandidate) {
    if (!ctxArgs) return;
    setPhase("busy");
    setActionError(null);
    try {
      await invoke("set_widget_image", { ...ctxArgs, url: c.url, source: c.source || null });
      await widgetCtx?.onChanged();
    } catch (e) {
      setActionError(String(e));
      setPhase("picking");
    }
  }
  async function generate() {
    if (!ctxArgs) return;
    setPhase("busy");
    setActionError(null);
    try {
      await invoke("generate_widget_image", ctxArgs);
      await widgetCtx?.onChanged();
    } catch (e) {
      setActionError(String(e));
      setPhase("notfound");
    }
  }
  async function remove() {
    if (!ctxArgs) return;
    setPhase("busy");
    try {
      await invoke("remove_widget", ctxArgs);
      await widgetCtx?.onChanged();
    } catch (e) {
      setActionError(String(e));
      setPhase("idle");
    }
  }

  const resolved = hasUrl && imgSrc && !imageFailed;
  const showActions = !!widgetCtx && !resolved;

  return (
    <figure className="widget widget-image">
      {widgetCtx && (
        <button
          type="button"
          className="widget-remove"
          onClick={(e) => {
            e.stopPropagation();
            remove();
          }}
          disabled={phase === "busy"}
          title={t("widgetRemove")}
          aria-label={t("widgetRemove")}
        >
          ×
        </button>
      )}
      {resolved ? (
        <button
          type="button"
          className="widget-image-link"
          onClick={() => onOpenImage?.(id)}
          aria-label={t("widgetImageOpen")}
          title={t("widgetImageOpen")}
        >
          <img
            src={imgSrc}
            alt={widget.alt || ""}
            className="widget-image-real"
            onError={() => setImageFailed(true)}
          />
        </button>
      ) : (
        <div className={`widget-image-box ${hasUrl ? "widget-image-error" : ""}`}>
          <span className="widget-label">
            {hasUrl ? t("widgetImageUnavailable") : t("widgetImage")}
          </span>
          <span className="widget-id">#{id}</span>
          {showActions && (
            <div className="widget-actions">
              {phase === "searching" || phase === "busy" ? (
                <span className="widget-action-status">
                  {phase === "searching" ? t("widgetSearching") : t("widgetWorking")}
                </span>
              ) : phase === "picking" ? (
                <div className="widget-candidates">
                  <div className="widget-candidates-grid">
                    {candidates.map((c, i) => (
                      <div key={i} className="widget-candidate-cell">
                        <button
                          type="button"
                          className="widget-candidate"
                          onClick={() => pick(c)}
                          title={c.title || c.source}
                        >
                          <img src={c.thumbnail || c.url} alt="" loading="lazy" />
                        </button>
                        <button
                          type="button"
                          className="widget-candidate-zoom"
                          onClick={(e) => {
                            e.stopPropagation();
                            setPreview(c);
                          }}
                          title={t("widgetCandidateZoom")}
                          aria-label={t("widgetCandidateZoom")}
                        >
                          🔍
                        </button>
                      </div>
                    ))}
                  </div>
                  <button type="button" className="widget-action-link" onClick={() => setPhase("idle")}>
                    {t("cancel")}
                  </button>
                </div>
              ) : phase === "notfound" ? (
                <div className="widget-notfound">
                  <span>{t("widgetNotFound")}</span>
                  <span className="widget-action-row">
                    <button type="button" className="widget-action-link" onClick={retry}>
                      {t("widgetRetry")}
                    </button>
                    {widgetCtx?.canGenerate && (
                      <button type="button" className="widget-action-link" onClick={generate}>
                        {t("widgetTryGenerate")}
                      </button>
                    )}
                  </span>
                </div>
              ) : (
                <button type="button" className="widget-action-link" onClick={retry}>
                  {t("widgetRetry")}
                </button>
              )}
              {actionError && <span className="widget-action-error">{actionError}</span>}
            </div>
          )}
        </div>
      )}
      <ImageCaption
        description={widget.description}
        generated={widget.generated}
        sourceHref={sourceHref}
      />
      {preview && (
        <div
          className="image-lightbox"
          role="dialog"
          aria-modal="true"
          onClick={() => setPreview(null)}
        >
          <div className="image-lightbox-stage" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="image-lightbox-close"
              onClick={() => setPreview(null)}
              aria-label={t("widgetImageLightboxClose")}
            >
              {t("widgetImageLightboxClose")}
            </button>
            <div className="image-lightbox-media">
              <img src={preview.url} alt={preview.title || ""} />
            </div>
            <div className="image-lightbox-caption">
              <button
                type="button"
                className="widget-candidate-use"
                onClick={() => {
                  const chosen = preview;
                  setPreview(null);
                  pick(chosen);
                }}
              >
                {t("widgetCandidateUse")}
              </button>
              {preview.source && <span className="widget-candidate-source">{preview.source}</span>}
            </div>
          </div>
        </div>
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
  const [renderError, setRenderError] = useState<string | null>(null);
  const [mode, setMode] = useState<"diagram" | "code">("diagram");
  const highlightedSource = useMemo(() => {
    try {
      return hljs.highlight(widget.source, { language: "mermaid" }).value;
    } catch {
      return null;
    }
  }, [widget.source]);
  const [zoomed, setZoomed] = useState(false);
  const [scale, setScale] = useState(1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scaleRef = useRef(1);
  scaleRef.current = scale;
  const pinchRef = useRef<{ dist: number; scale: number } | null>(null);

  useEffect(() => {
    // Always render with the real Mermaid parser — it is the source of truth.
    // A stored `widget.error` (from the generation-time heuristic) is used only
    // as a fallback message if the real render also fails, so a diagram that was
    // wrongly flagged still renders.
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
        if (!cancelled) setRenderError(String(e?.message ?? e) || widget.error || "render failed");
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
        <>
          <div className="widget-diagram-toolbar" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "diagram"}
              className={mode === "diagram" ? "active" : ""}
              onClick={() => setMode("diagram")}
            >
              {t("diagramViewDiagram")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "code"}
              className={mode === "code" ? "active" : ""}
              onClick={() => setMode("code")}
            >
              {t("diagramViewCode")}
            </button>
          </div>
          {mode === "code" ? (
            <pre className="widget-diagram-code">
              {highlightedSource ? (
                <code
                  className="hljs language-mermaid"
                  dangerouslySetInnerHTML={{ __html: highlightedSource }}
                />
              ) : (
                <code className="hljs language-mermaid">{widget.source}</code>
              )}
            </pre>
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
        </>
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
            <button onClick={() => setZoomed(false)} aria-label={t("close")}>
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
  if (state === "queued") {
    return (
      <span className="state-icon queued" title={t("stateQueued")} aria-label={t("stateQueued")}>
        …
      </span>
    );
  }
  if (state === "ready") {
    return (
      <span className="state-icon ready" title={t("stateReady")} aria-label={t("stateReady")}>
        ✓
      </span>
    );
  }
  if (state === "failed") {
    return (
      <span className="state-icon failed" title={t("stateFailed")} aria-label={t("stateFailed")}>
        !
      </span>
    );
  }
  return null;
}

export default App;

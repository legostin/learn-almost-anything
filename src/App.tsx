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

// Generation cost/quality tier chosen at course creation; mirrors the Rust
// GenerationProfile tier (settings.rs). Blank knobs resolve from the tier preset.
type GenerationTier = "quick" | "balanced" | "premium";
const DEFAULT_GENERATION_TIER: GenerationTier = "balanced";
const GENERATION_TIERS = [
  { value: "quick", titleKey: "tierQuickTitle", descKey: "tierQuickDesc" },
  { value: "balanced", titleKey: "tierBalancedTitle", descKey: "tierBalancedDesc" },
  { value: "premium", titleKey: "tierPremiumTitle", descKey: "tierPremiumDesc" },
] as const satisfies ReadonlyArray<{
  value: GenerationTier;
  titleKey: "tierQuickTitle" | "tierBalancedTitle" | "tierPremiumTitle";
  descKey: "tierQuickDesc" | "tierBalancedDesc" | "tierPremiumDesc";
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

type QnA = { question: string; answer: string };

// One step of the adaptive clarifying interview returned by wizard_next_question.
type WizardStep = { title?: string | null; done: boolean; question?: Question };

// Persisted running interview (for cross-session resume) from get_wizard_dialog.
type WizardDialog = {
  title?: string | null;
  answered?: QnA[];
  current?: Question | null;
  done?: boolean;
  // True while a wizard_next_question call is in flight (persisted before the
  // sidecar runs) — lets a remount resume instead of restarting the interview.
  pending?: boolean;
};

type GenState = "pending" | "queued" | "generating" | "ready" | "failed";

type ModuleNode = {
  id: string;
  title: string;
  summary: string;
  generation_state: GenState;
  test_passed?: boolean;
  test_passed_at?: number | null;
  prereqs?: string[];
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

type JobKind = "build_structure" | "generate_submodule" | "translate";

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
  | { kind: "review"; courseId?: string }
  | { kind: "submodule"; courseId: string; moduleId: string; submoduleId: string };

// One FSRS card row (srs::CardRow, camelCase via serde).
type SrsCard = {
  id: string;
  courseId: string;
  moduleId: string;
  submoduleId: string;
  kind: string;
  front: string;
  back: string;
  concept?: string | null;
  anchor?: string | null;
  state: number; // 0 New, 1 Learning, 2 Review, 3 Relearning
  dueAt: number;
  stability: number;
  difficulty: number;
  elapsedDays: number;
  scheduledDays: number;
  reps: number;
  lapses: number;
  lastReviewAt?: number | null;
  suspended: boolean;
  leech: boolean;
};

// Queue entry from get_due_cards: card fields flattened + context + previews.
type DueCard = SrsCard & {
  courseTitle: string;
  submoduleTitle: string;
  preview: { again: number; hard: number; good: number; easy: number };
};

type GradeOutcome = { card: SrsCard; becameLeech: boolean };

// Submodule card with interval previews (in-lesson recall widgets).
type SubCard = SrsCard & {
  preview: { again: number; hard: number; good: number; easy: number };
};

/** Local-midnight offset the SRS daily budget math needs (seconds east of UTC). */
function tzOffsetSecs(): number {
  return -new Date().getTimezoneOffset() * 60;
}

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
  enabled: boolean;
};

type StageName = "draft" | "annotate" | "illustrate" | "test";

type TestQuestion = {
  text: string;
  options: string[];
  correct: number;
  explanation: string;
  concept?: string;
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
type BackendModels = {
  planning: StageModel;
  writing: StageModel;
  tests: StageModel;
  assistant: StageModel;
  utility: StageModel;
  verify: StageModel;
};
type ModelConfig = { claude: BackendModels; codex: BackendModels };
type ModelBackend = "claude" | "codex";
type ModelCategory = "planning" | "writing" | "tests" | "assistant" | "utility" | "verify";
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
  const [reviewDueTotal, setReviewDueTotal] = useState(0);
  const [jobs, setJobs] = useState<Map<string, JobState>>(new Map());
  const [translateStatus, setTranslateStatus] = useState<
    Map<string, { done: number; total: number; complete: boolean }>
  >(new Map());
  const [stages, setStages] = useState<Map<string, StageDetail>>(new Map());
  const [transcripts, setTranscripts] = useState<Map<string, Bubble[]>>(new Map());
  const [subErrors, setSubErrors] = useState<Map<string, string>>(new Map());
  const [recentCourseIds, setRecentCourseIds] = useState<string[]>(readRecentCourseIds);
  const [wizardDialogById, setWizardDialogById] = useState<Map<string, WizardDialog>>(
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

  const refreshReviewDue = useCallback(async () => {
    try {
      const counts = await invoke<Record<string, number>>("due_card_counts", {
        tzOffsetSecs: tzOffsetSecs(),
      });
      setReviewDueTotal(Object.values(counts).reduce((a, b) => a + b, 0));
    } catch {
      setReviewDueTotal(0);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Refresh the due-review badge when the course set changes or we leave the
  // review screen (so a finished session updates the count).
  useEffect(() => {
    refreshReviewDue();
  }, [refreshReviewDue, courses, view.kind]);

  useEffect(() => {
    let cancelled = false;
    const wizardCourses = courses.filter((course) => course.status === "wizard");
    if (wizardCourses.length === 0) {
      setWizardDialogById(new Map());
      return;
    }
    Promise.all(
      wizardCourses.map(async (course) => {
        try {
          const dialog = await invoke<WizardDialog>("get_wizard_dialog", {
            courseId: course.id,
          });
          return [course.id, dialog ?? {}] as const;
        } catch {
          return [course.id, {} as WizardDialog] as const;
        }
      })
    ).then((entries) => {
      if (!cancelled) setWizardDialogById(new Map(entries));
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
      // After the plan is built we intentionally stop and let the user review
      // and confirm it. Submodule generation is started explicitly from the
      // plan view ("Generate full course"), not automatically here.
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
    if (kind === "build_structure") {
      setTranscripts((prev) => {
        const next = new Map(prev);
        next.set(courseId, [{ kind: "running", text: t("buildingStructure") }]);
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
      // The adaptive wizard auto-starts its first question when opened.
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
          {reviewDueTotal > 0 && (
            <button
              className={`sidebar-link ${view.kind === "review" ? "active" : ""}`}
              onClick={() => setView({ kind: "review" })}
            >
              {t("reviewNav")} <span className="review-due-badge">{reviewDueTotal}</span>
            </button>
          )}
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
            const hasRunning =
              jobs.get(jobKey(c.id, "build_structure"))?.status === "running";
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
        {view.kind === "empty" && reviewDueTotal > 0 && (
          <button className="review-banner" onClick={() => setView({ kind: "review" })}>
            <span className="review-banner-icon">🔁</span>
            <span className="review-banner-text">
              {t("reviewBannerBody", { count: reviewDueTotal })}
            </span>
            <span className="review-banner-cta">{t("reviewBannerCta")} →</span>
          </button>
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
            wizardDialogById={wizardDialogById}
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
        {view.kind === "review" && (
          <ReviewSession
            courseId={view.courseId ?? null}
            onClose={() => {
              refreshReviewDue();
              setView({ kind: "empty" });
            }}
            onGraded={refreshReviewDue}
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
          <SpaceView
            spaceId={view.id}
            courses={courses.filter((c) => c.space_id === view.id)}
            onBack={() => setView({ kind: "spaces" })}
            onOpenCourse={openCourse}
            onCreateCourse={() => setView({ kind: "creating", spaceId: view.id })}
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
              openSubmodule(view.id, moduleId, submoduleId)
            }
            onStartSubGen={(submoduleId) => startSubmoduleGen(view.id, submoduleId)}
            onDeleted={async () => {
              setView({ kind: "empty" });
              await refresh();
            }}
            onOpenCourse={openCourse}
            onReview={() => setView({ kind: "review", courseId: view.id })}
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
  wizardDialogById,
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
  wizardDialogById: Map<string, WizardDialog>;
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
    ).then(async (entries) => {
      if (cancelled) return;
      const map = new Map(entries);
      try {
        const counts = await invoke<Record<string, number>>("due_card_counts", {
          tzOffsetSecs: tzOffsetSecs(),
        });
        for (const [cid, n] of Object.entries(counts)) {
          const p = map.get(cid);
          if (p) p.reviewDue = n;
        }
      } catch {
        /* leave reviewDue at 0 */
      }
      if (!cancelled) setProgressById(new Map(map));
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
    const structureJob = jobs.get(jobKey(course.id, "build_structure"));
    const verifiedPercent =
      progress && progress.total > 0 ? Math.round((progress.verified / progress.total) * 100) : 0;

    let actionLabel = t("courseActionOpen");
    let actionDisabled = false;
    let action = () => onOpenCourse(course.id);
    let statusText = t("courseStatusOpen");
    let needsAction = false;

    if (course.status === "wizard") {
      // The clarifying interview is now an interactive in-course dialog — the
      // card just opens it; the label reflects whether it's already underway.
      const dialog = wizardDialogById.get(course.id);
      const inProgress = !!(dialog && ((dialog.answered?.length ?? 0) > 0 || dialog.current));
      actionLabel = inProgress
        ? t("courseActionAnswerQuestions")
        : t("courseActionStartQuestions");
      statusText = inProgress ? t("courseStatusNeedsAnswers") : t("courseStatusNeedsQuestions");
      action = () => onOpenCourse(course.id);
      needsAction = true;
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
        [cat]: { ...(models[modelBackend][cat] ?? { model: null, reasoning: null }), ...patch },
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
            {(
              ["planning", "writing", "tests", "assistant", "utility", "verify"] as const
            ).map((cat) => {
              const sm = models[modelBackend][cat] ?? { model: null, reasoning: null };
              const list = modelList[modelBackend];
              const loading = list === null;
              const levels = effortLevelsFor(sm.model);
              const defaultEntry = (list ?? []).find((m) => m.value === "default");
              const defaultName = defaultEntry?.description?.split("·")[0]?.trim();
              // Utility's blank model means "auto-pick the cheapest available",
              // not the agent default.
              const defaultLabel =
                cat === "utility"
                  ? t("modelsAutoCheap")
                  : defaultName
                    ? `${t("modelsDefault")} · ${defaultName}`
                    : t("modelsDefault");
              const catLabel =
                cat === "planning"
                  ? t("modelsCatPlanning")
                  : cat === "writing"
                    ? t("modelsCatWriting")
                    : cat === "tests"
                      ? t("modelsCatTests")
                      : cat === "assistant"
                        ? t("modelsCatAssistant")
                        : cat === "utility"
                          ? t("modelsCatUtility")
                          : t("modelsCatVerify");
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
  courses,
  onBack,
  onOpenCourse,
  onCreateCourse,
}: {
  spaceId: string;
  courses: Course[];
  onBack: () => void;
  onOpenCourse: (id: string) => void;
  onCreateCourse: () => void;
}) {
  const t = useT();
  const [uiLang] = useLang();
  const [space, setSpace] = useState<Space | null>(null);
  const [sources, setSources] = useState<SpaceSource[]>([]);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkKind, setLinkKind] = useState<"site" | "repo">("site");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [preview, setPreview] = useState<{ title: string; md: string } | null>(null);
  const [refreshing, setRefreshing] = useState<Set<string>>(() => new Set());
  // Space chat (ask the knowledge base without a course).
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMsgs, setChatMsgs] = useState<{ role: "user" | "assistant"; text: string }[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [converter, setConverter] = useState<{
    available: boolean;
    full: boolean;
    via: string;
  } | null>(null);
  const [installing, setInstalling] = useState(false);

  const checkConverter = useCallback(async () => {
    try {
      setConverter(
        await invoke<{ available: boolean; full: boolean; via: string }>("markitdown_status")
      );
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

  async function toggleSource(s: SpaceSource) {
    try {
      await invoke("set_space_source_enabled", { sourceId: s.id, enabled: !s.enabled });
      await reload();
    } catch (e) {
      setError(String(e));
    }
  }

  async function refreshSource(id: string) {
    setRefreshing((prev) => new Set(prev).add(id));
    try {
      await invoke("refresh_space_source", { sourceId: id });
    } catch (e) {
      setError(String(e));
    } finally {
      setRefreshing((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      await reload();
    }
  }

  async function openPreview(s: SpaceSource) {
    if (!s.md_path) return;
    try {
      const md = await invoke<string>("read_space_source_md", { sourceId: s.id });
      setPreview({ title: s.title, md });
    } catch (e) {
      setError(String(e));
    }
  }

  async function sendChat() {
    const q = chatInput.trim();
    if (!q || chatBusy) return;
    const history = chatMsgs.map((m) => ({ role: m.role, text: m.text }));
    setChatMsgs((prev) => [...prev, { role: "user", text: q }]);
    setChatInput("");
    setChatBusy(true);
    try {
      const answer = await invoke<string>("ask_space_assistant", {
        spaceId,
        question: q,
        history,
        language: uiLang,
      });
      setChatMsgs((prev) => [...prev, { role: "assistant", text: answer || "…" }]);
    } catch (e) {
      setError(String(e));
    } finally {
      setChatBusy(false);
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

      {converter && (!converter.available || !converter.full) && (
        <div className="converter-banner">
          <span>
            {!converter.available ? t("converterMissing") : t("converterNoExtras")}
          </span>
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
            <li
              key={s.id}
              className={`source-item status-${s.status}${s.enabled ? "" : " source-disabled"}`}
            >
              <span className="source-icon">{SOURCE_KIND_ICON[s.kind] ?? "📄"}</span>
              <div className="source-body">
                {s.md_path ? (
                  <button className="source-title source-title-link" onClick={() => openPreview(s)}>
                    {s.title}
                  </button>
                ) : (
                  <div className="source-title">{s.title}</div>
                )}
                {(s.kind === "site" || s.kind === "repo" || s.kind === "directory") && (
                  <div className="source-ref">{s.ref}</div>
                )}
                {s.status === "failed" && s.error && (
                  <div className="source-error">{s.error}</div>
                )}
                {(s.status === "converting" || refreshing.has(s.id)) && (
                  <div className="source-ref">{t("spaceConverting")}</div>
                )}
              </div>
              {s.status === "failed" && (
                <button
                  className="source-action"
                  disabled={refreshing.has(s.id)}
                  onClick={() => refreshSource(s.id)}
                >
                  {t("spaceSrcRetry")}
                </button>
              )}
              {s.status === "ready" && (s.kind === "site" || s.md_path) && (
                <button
                  className="source-action"
                  title={t("spaceSrcRefresh")}
                  disabled={refreshing.has(s.id)}
                  onClick={() => refreshSource(s.id)}
                >
                  🔄
                </button>
              )}
              <button
                className="source-action"
                title={s.enabled ? t("spaceSrcDisable") : t("spaceSrcEnable")}
                onClick={() => toggleSource(s)}
              >
                {s.enabled ? "👁" : "🚫"}
              </button>
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

      <div className="space-chat">
        <button className="space-chat-toggle" onClick={() => setChatOpen((v) => !v)}>
          💬 {t("spaceChatTitle")}
        </button>
        {chatOpen && (
          <div className="space-chat-panel">
            {chatMsgs.length === 0 && (
              <div className="setting-note">{t("spaceChatHint")}</div>
            )}
            {chatMsgs.map((m, i) => (
              <div key={i} className={`space-chat-msg ${m.role}`}>
                <MathMarkdown>{m.text}</MathMarkdown>
              </div>
            ))}
            {chatBusy && <div className="setting-note">{t("aiBusyShort")}</div>}
            <div className="space-chat-input">
              <textarea
                rows={2}
                value={chatInput}
                placeholder={t("spaceChatPlaceholder")}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    sendChat();
                  }
                }}
              />
              <button disabled={chatBusy || !chatInput.trim()} onClick={sendChat}>
                ↑
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="space-courses">
        <div className="space-courses-head">
          <h3>{t("spaceCoursesTitle")}</h3>
          <button className="meta-action" onClick={onCreateCourse}>
            ＋ {t("spaceCoursesCreate")}
          </button>
        </div>
        {courses.length === 0 ? (
          <div className="setting-note">{t("spaceCoursesEmpty")}</div>
        ) : (
          <>
            {(() => {
              const newestSource = Math.max(0, ...sources.map((s) => s.created_at));
              const stale = courses.some(
                (c) => c.status === "ready" && newestSource > c.updated_at
              );
              return stale ? (
                <div className="space-stale-hint">{t("spaceCoursesStale")}</div>
              ) : null;
            })()}
            <ul className="space-course-list">
              {courses.map((c) => (
                <li key={c.id}>
                  <button className="space-course-item" onClick={() => onOpenCourse(c.id)}>
                    <span className="space-course-title">
                      {c.title || c.topic}
                    </span>
                    <span className="space-course-status">{c.status}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {preview && (
        <div className="modal-backdrop" onClick={() => setPreview(null)}>
          <div
            className="modal space-preview-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <h2>{preview.title}</h2>
            <div className="space-preview-body reader">
              <MathMarkdown>{preview.md}</MathMarkdown>
            </div>
            <div className="modal-actions">
              <button onClick={() => setPreview(null)}>{t("cancel")}</button>
            </div>
          </div>
        </div>
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
  const [tier, setTier] = useState<GenerationTier>(DEFAULT_GENERATION_TIER);
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
    // Record the chosen cost/quality tier on the course (drives stage gating
    // and the sidecar depth/pedagogy knobs during generation).
    await invoke("set_course_profile", { courseId: id, profile: { tier } }).catch(() => {});
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
        {t("tierLabel")}
        <div className="format-picker">
          {GENERATION_TIERS.map((item) => (
            <label
              key={item.value}
              className={`format-option ${tier === item.value ? "selected" : ""}`}
            >
              <input
                type="radio"
                name="generation-tier"
                value={item.value}
                checked={tier === item.value}
                onChange={() => setTier(item.value)}
              />
              <div className="format-meta">
                <div className="format-title">{t(item.titleKey)}</div>
                <div className="format-desc">{t(item.descKey)}</div>
              </div>
            </label>
          ))}
        </div>
        <span className="field-note">{t("tierNote")}</span>
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
  structureTranscript,
  onStartJob,
  onChanged,
  onOpenSub,
  onStartSubGen,
  onDeleted,
  onOpenCourse,
  onReview,
  translateStatus,
}: {
  course?: Course;
  jobs: Map<string, JobState>;
  structureTranscript: Bubble[] | null;
  onStartJob: (kind: JobKind) => void;
  onChanged: () => void | Promise<void>;
  onOpenSub: (moduleId: string, submoduleId: string) => void;
  onStartSubGen: (submoduleId: string) => void | Promise<void>;
  onDeleted: () => void | Promise<void>;
  onOpenCourse: (id: string) => void;
  onReview: () => void;
  translateStatus?: { done: number; total: number; complete: boolean };
}) {
  const t = useT();
  const [uiLang] = useLang();
  const [translateOpen, setTranslateOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [courseTab, setCourseTab] = useState<"plan" | "mastery">("plan");
  const [translating, setTranslating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [publishUrl, setPublishUrl] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<CatalogUpdateStatus | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updatingCatalog, setUpdatingCatalog] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);

  // Once the wizard is done the course enters "structuring"; start the
  // plan-building agent automatically (no extra confirmation screen). Guarded
  // so it fires once per course and never restarts an existing (running /
  // errored / finished) job. Submodule generation is NOT auto-started here —
  // it waits for the user to confirm the plan.
  const autoStartedStructuring = useRef<string | null>(null);
  useEffect(() => {
    if (!course || course.status !== "structuring") return;
    if (jobs.has(jobKey(course.id, "build_structure"))) return;
    if (autoStartedStructuring.current === course.id) return;
    autoStartedStructuring.current = course.id;
    onStartJob("build_structure");
  }, [course, jobs, onStartJob]);

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
          {!!course.catalog_origin_id && course.catalog_origin_id !== course.id && (
            <span className="translated-badge" title={t("importedBadgeHint")}>
              📥 {t("importedBadge")}
            </span>
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
          {course.status === "ready" &&
            !(!!course.catalog_origin_id && course.catalog_origin_id !== course.id) && (
            <button className="meta-action" onClick={publishCourse} disabled={publishing}>
              {publishing ? t("catalogPublishing") : t("catalogPublish")}
            </button>
          )}
          <button className="meta-action" onClick={() => setProfileOpen(true)}>
            {t("profileTitle")}
          </button>
        </div>
      </div>
      {profileOpen && (
        <LearnerProfileModal course={course} onClose={() => setProfileOpen(false)} />
      )}
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
        <Wizard key={course.id} course={course} onSaved={onChanged} />
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
        <>
          <div className="course-tabs">
            <button
              className={`course-tab${courseTab === "plan" ? " active" : ""}`}
              onClick={() => setCourseTab("plan")}
            >
              {t("courseTabPlan")}
            </button>
            <button
              className={`course-tab${courseTab === "mastery" ? " active" : ""}`}
              onClick={() => setCourseTab("mastery")}
            >
              {t("masteryTab")}
            </button>
          </div>
          {courseTab === "plan" ? (
            <Structure
              course={course}
              onOpenSub={onOpenSub}
              onStartSubGen={onStartSubGen}
            />
          ) : (
            <MasteryView course={course} onOpenSub={onOpenSub} onReview={onReview} />
          )}
        </>
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

// Edit the learner profile (level/goals/time/prior knowledge) that modulates
// every future generation. Affects newly generated/regenerated lessons only.
function LearnerProfileModal({
  course,
  onClose,
}: {
  course: Course;
  onClose: () => void;
}) {
  const t = useT();
  const [loaded, setLoaded] = useState(false);
  const [profile, setProfile] = useState<Record<string, unknown>>({});
  const [level, setLevel] = useState("");
  const [goals, setGoals] = useState("");
  const [weeklyMinutes, setWeeklyMinutes] = useState("");
  const [priorKnowledge, setPriorKnowledge] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<Record<string, unknown> | null>("get_learner_profile", { courseId: course.id })
      .then((p) => {
        if (cancelled) return;
        const prof = p ?? {};
        setProfile(prof);
        setLevel(typeof prof.level === "string" ? prof.level : "");
        setGoals(typeof prof.goals === "string" ? prof.goals : "");
        setWeeklyMinutes(
          typeof prof.weeklyMinutes === "number" ? String(prof.weeklyMinutes) : ""
        );
        setPriorKnowledge(typeof prof.priorKnowledge === "string" ? prof.priorKnowledge : "");
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [course.id]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const next: Record<string, unknown> = { ...profile, version: 1 };
      if (level) next.level = level;
      else delete next.level;
      if (goals.trim()) next.goals = goals.trim();
      else delete next.goals;
      const mins = Math.round(Number(weeklyMinutes));
      if (Number.isFinite(mins) && mins > 0) next.weeklyMinutes = mins;
      else delete next.weeklyMinutes;
      if (priorKnowledge.trim()) next.priorKnowledge = priorKnowledge.trim();
      else delete next.priorKnowledge;
      await invoke("set_learner_profile", { courseId: course.id, profile: next });
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <h2>{t("profileTitle")}</h2>
        <p className="setting-note">{t("profileSavedNote")}</p>
        {!loaded ? (
          <div className="placeholder">{t("loadingStructure")}</div>
        ) : (
          <div className="lp-fields">
            <label className="lp-field">
              <span>{t("profileLevel")}</span>
              <select value={level} onChange={(e) => setLevel(e.target.value)}>
                <option value="">—</option>
                <option value="novice">{t("profileLevelNovice")}</option>
                <option value="amateur">{t("profileLevelAmateur")}</option>
                <option value="intermediate">{t("profileLevelIntermediate")}</option>
                <option value="advanced">{t("profileLevelAdvanced")}</option>
              </select>
            </label>
            <label className="lp-field">
              <span>{t("profileGoals")}</span>
              <textarea rows={2} value={goals} onChange={(e) => setGoals(e.target.value)} />
            </label>
            <label className="lp-field">
              <span>{t("profileTime")}</span>
              <input
                type="number"
                min={0}
                value={weeklyMinutes}
                onChange={(e) => setWeeklyMinutes(e.target.value)}
              />
            </label>
            <label className="lp-field">
              <span>{t("profilePrior")}</span>
              <textarea
                rows={2}
                value={priorKnowledge}
                onChange={(e) => setPriorKnowledge(e.target.value)}
              />
            </label>
          </div>
        )}
        {error && <p className="error-banner">{t("errorPrefix", { error })}</p>}
        <div className="modal-actions">
          <button onClick={onClose} disabled={busy}>
            {t("cancel")}
          </button>
          <button onClick={save} disabled={busy || !loaded}>
            {busy ? t("profileSaving") : t("profileSave")}
          </button>
        </div>
      </div>
    </div>
  );
}

const WIZARD_MIN_QUESTIONS = 3;

// Animated loader shown while the next wizard question is being generated (the
// call is async, so this animates smoothly without freezing the UI).
function WizardLoader() {
  const t = useT();
  return (
    <div className="wizard wizard-loading" aria-busy="true">
      <div className="wizard-loader-head">
        <span className="wizard-loader-orb" />
        <span className="wizard-loader-label">{t("wizardThinking")}</span>
      </div>
      <div className="wizard-skeleton" aria-hidden="true">
        <div className="wizard-skel wizard-skel-q" />
        <div className="wizard-skel-options">
          <span className="wizard-skel wizard-skel-opt" />
          <span className="wizard-skel wizard-skel-opt" />
          <span className="wizard-skel wizard-skel-opt" />
        </div>
      </div>
    </div>
  );
}

// Adaptive clarifying interview: one question at a time, each generated from the
// answers so far (3-10 total). The component is the authority for its own state:
// it loads the persisted dialog from disk on mount (keyed by course.id via the
// parent), so a remount / course switch / cold open resumes instead of restarting
// and overwriting the saved answers.
function Wizard({
  course,
  onSaved,
}: {
  course: Course;
  onSaved: () => void | Promise<void>;
}) {
  const t = useT();
  const [answered, setAnswered] = useState<QnA[]>([]);
  const [current, setCurrent] = useState<Question | null>(null);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);
  const startedRef = useRef(false);
  const finalizedRef = useRef(false);

  const askNext = useCallback(
    async (history: QnA[], reRequested = false) => {
      setLoading(true);
      setError(null);
      try {
        const step = await invoke<WizardStep>("wizard_next_question", {
          courseId: course.id,
          answered: history,
        });
        if (step.question) {
          setAnswered(history);
          setCurrent(step.question);
          setDone(false);
          setPending(false);
        } else if (history.length < WIZARD_MIN_QUESTIONS && !reRequested) {
          // Model finished before the 3-question floor — ask once more rather
          // than dropping the learner onto an under-clarified build screen.
          await askNext(history, true);
        } else {
          setAnswered(history);
          setCurrent(null);
          setDone(true);
          setPending(false);
        }
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    },
    [course.id]
  );

  // Load the persisted dialog (if any) before deciding whether to auto-start.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const d = await invoke<WizardDialog>("get_wizard_dialog", { courseId: course.id });
        if (cancelled) return;
        setAnswered(d?.answered ?? []);
        setCurrent(d?.current ?? null);
        setDone(!!d?.done);
        setPending(!!d?.pending);
      } catch {
        // Leave defaults; auto-start begins a fresh interview.
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [course.id]);

  // After hydration: start the first question (fresh course) or regenerate the
  // next one if a prior call was abandoned in flight (`pending`); otherwise the
  // persisted `current`/`done` already drives the UI.
  useEffect(() => {
    if (!hydrated || startedRef.current) return;
    startedRef.current = true;
    if (done || current) return;
    if (pending || answered.length === 0) {
      askNext(answered);
    }
  }, [hydrated, done, current, pending, answered, askNext]);

  async function submitAnswer(answer: string) {
    if (!current) return;
    const history = [...answered, { question: current.text, answer }];
    setAnswered(history);
    setCurrent(null);
    await askNext(history);
  }

  async function buildCourse(history: QnA[]) {
    setFinishing(true);
    setError(null);
    try {
      await invoke("save_wizard_answers", { courseId: course.id, answers: history });
      // Distill the interview into a learner profile (level/goals/time/prior
      // knowledge) that every later generation stage adapts to. Best-effort:
      // a failed extraction must never block the course.
      try {
        await invoke("extract_learner_profile", { courseId: course.id });
      } catch {
        /* profile is an enhancement, not a gate */
      }
      await onSaved();
    } catch (e) {
      setError(String(e));
      setFinishing(false);
    }
  }

  // Once the interview is complete with enough answers, finalize automatically:
  // persist the answers and hand off to plan generation. No extra "build" click.
  useEffect(() => {
    if (!hydrated || loading || !done) return;
    if (answered.length < WIZARD_MIN_QUESTIONS) return;
    if (finalizedRef.current || finishing || error) return;
    finalizedRef.current = true;
    buildCourse(answered);
    // buildCourse is a stable closure over course/onSaved; guarded by finalizedRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, loading, done, answered, finishing, error]);

  if (!hydrated || loading) {
    return <WizardLoader />;
  }

  if (error && !current && !done) {
    return (
      <div className="wizard error">
        <p>{t("errorPrefix", { error })}</p>
        <button onClick={() => askNext(answered)}>{t("retry")}</button>
      </div>
    );
  }

  if (done || !current) {
    const enough = answered.length >= WIZARD_MIN_QUESTIONS;
    if (!enough) {
      return (
        <div className="wizard">
          <p>{t("wizardNeedMore", { min: WIZARD_MIN_QUESTIONS })}</p>
          <button onClick={() => askNext(answered)}>{t("wizardSubmit")}</button>
          {error && <p style={{ color: "var(--danger)" }}>{t("errorPrefix", { error })}</p>}
        </div>
      );
    }
    // Enough answers: the effect above auto-finalizes. Show progress, or an
    // error with a manual retry if persisting the answers failed.
    if (error) {
      return (
        <div className="wizard error">
          <p>{t("errorPrefix", { error })}</p>
          <button onClick={() => buildCourse(answered)}>{t("retry")}</button>
        </div>
      );
    }
    return <WizardLoader />;
  }

  return (
    <WizardQuestion
      key={answered.length}
      question={current}
      index={answered.length}
      canFinishEarly={answered.length >= WIZARD_MIN_QUESTIONS}
      finishing={finishing}
      onSubmit={submitAnswer}
      onFinishEarly={() => buildCourse(answered)}
      error={error}
    />
  );
}

// A single adaptive-wizard question: option chips (multi/single) + free text.
function WizardQuestion({
  question,
  index,
  canFinishEarly,
  finishing,
  onSubmit,
  onFinishEarly,
  error,
}: {
  question: Question;
  index: number;
  canFinishEarly: boolean;
  finishing: boolean;
  onSubmit: (answer: string) => void | Promise<void>;
  onFinishEarly: () => void;
  error: string | null;
}) {
  const t = useT();
  const isMulti = question.multi !== false;
  const [selected, setSelected] = useState<number[]>([]);
  const [custom, setCustom] = useState("");

  function toggle(optIdx: number) {
    if (isMulti) {
      setSelected((cur) =>
        cur.includes(optIdx)
          ? cur.filter((x) => x !== optIdx)
          : [...cur, optIdx].sort((a, b) => a - b)
      );
    } else {
      setSelected((cur) => (cur[0] === optIdx ? [] : [optIdx]));
    }
  }

  function resolved(): string {
    const c = custom.trim();
    const picked = selected.map((i) => question.options[i]).filter(Boolean);
    if (picked.length === 0) return c;
    return c ? `${picked.join(", ")}; ${c}` : picked.join(", ");
  }

  const answer = resolved();

  return (
    <div className="wizard">
      <div className="wizard-progress">{t("wizardQuestionProgress", { n: index + 1 })}</div>
      <div className="q">
        {question.text}
        {question.options.length > 0 && (
          <span className={`q-mode q-mode-${isMulti ? "multi" : "single"}`}>
            {isMulti ? t("optMulti") : t("optSingle")}
          </span>
        )}
      </div>
      {question.options.length > 0 && (
        <div className="options">
          {question.options.map((opt, j) => (
            <label key={j} className="option">
              <input
                type={isMulti ? "checkbox" : "radio"}
                name={isMulti ? undefined : "wizard-q"}
                checked={selected.includes(j)}
                onChange={() => toggle(j)}
              />
              <span>{opt}</span>
            </label>
          ))}
        </div>
      )}
      <input
        className="custom-answer"
        type="text"
        value={custom}
        placeholder={t("customAnswerPlaceholder")}
        onChange={(e) => setCustom(e.target.value)}
      />
      <div className="wizard-actions">
        <button onClick={() => onSubmit(answer)} disabled={!answer || finishing}>
          {t("wizardSubmit")}
        </button>
        {canFinishEarly && (
          <button className="ghost" onClick={onFinishEarly} disabled={finishing}>
            {finishing ? t("saving") : t("wizardFinishEarly")}
          </button>
        )}
      </div>
      {error && <p style={{ color: "var(--danger)" }}>{t("errorPrefix", { error })}</p>}
    </div>
  );
}

// Optional entry diagnostic (5-8 laddered MCQs) offered before structure
// generation: results land in learner_profile + course.md ## Diagnostic, so
// buildStructure compresses what's solid and scaffolds what's weak.
function DiagnosticQuiz({
  course,
  onDone,
}: {
  course: Course;
  onDone: () => void;
}) {
  const t = useT();
  const [phase, setPhase] = useState<"offer" | "loading" | "quiz" | "saving">("offer");
  const [questions, setQuestions] = useState<TestQuestion[]>([]);
  const [answers, setAnswers] = useState<(number | null)[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setPhase("loading");
    setError(null);
    try {
      const qs = await invoke<TestQuestion[]>("generate_diagnostic", {
        courseId: course.id,
      });
      if (!qs.length) throw new Error("empty diagnostic");
      setQuestions(qs);
      setAnswers(qs.map(() => null));
      setPhase("quiz");
    } catch (e) {
      setError(String(e));
      setPhase("offer");
    }
  }

  async function submit() {
    setPhase("saving");
    try {
      await invoke("submit_diagnostic_result", {
        courseId: course.id,
        results: questions.map((q, i) => ({
          concept: (q as { concept?: string }).concept ?? "",
          difficulty: (q as { difficulty?: number }).difficulty ?? 2,
          correct: answers[i] === q.correct,
        })),
      });
    } catch {
      /* non-fatal: the course just builds without diagnostic data */
    }
    onDone();
  }

  if (phase === "offer") {
    return (
      <div className="diagnostic-offer">
        <p>{t("diagnosticOffer")}</p>
        <div className="diagnostic-offer-actions">
          <button onClick={start}>{t("diagnosticStart")}</button>
          <button className="ghost" onClick={onDone}>
            {t("diagnosticSkip")}
          </button>
        </div>
        {error && <p style={{ color: "var(--danger)" }}>{t("errorPrefix", { error })}</p>}
      </div>
    );
  }
  if (phase === "loading" || phase === "saving") {
    return (
      <div className="diagnostic-offer">
        <span className="spinner" /> {phase === "loading" ? t("diagnosticLoading") : t("diagnosticSaving")}
      </div>
    );
  }
  const allAnswered = answers.every((a) => a !== null);
  return (
    <div className="diagnostic-quiz">
      <p className="diagnostic-intro">{t("diagnosticIntro")}</p>
      <ol className="test-questions">
        {questions.map((q, i) => (
          <li key={i} className="test-q">
            <div className="test-q-text">{q.text}</div>
            <div className="test-options">
              {q.options.map((opt, j) => (
                <label key={j} className={`test-option${answers[i] === j ? " chosen" : ""}`}>
                  <input
                    type="radio"
                    name={`diag-${i}`}
                    checked={answers[i] === j}
                    onChange={() =>
                      setAnswers((prev) => prev.map((a, k) => (k === i ? j : a)))
                    }
                  />
                  <span>{opt}</span>
                </label>
              ))}
            </div>
          </li>
        ))}
      </ol>
      <button className="test-start" onClick={submit} disabled={!allAnswered}>
        {t("diagnosticSubmit")}
      </button>
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
  // Offer the diagnostic once: skip if already taken (profile.diagnostic) or
  // dismissed this session.
  const [diagState, setDiagState] = useState<"unknown" | "offer" | "done">("unknown");
  useEffect(() => {
    let cancelled = false;
    invoke<Record<string, unknown> | null>("get_learner_profile", { courseId: course.id })
      .then((p) => {
        if (!cancelled) setDiagState(p && p.diagnostic ? "done" : "offer");
      })
      .catch(() => {
        if (!cancelled) setDiagState("offer");
      });
    return () => {
      cancelled = true;
    };
  }, [course.id]);
  if (diagState === "unknown") {
    return <WizardLoader />;
  }
  if (diagState === "offer" && !running && !errored) {
    return (
      <div className="wizard">
        <DiagnosticQuiz course={course} onDone={() => setDiagState("done")} />
      </div>
    );
  }
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

// Knowledge view: the course tree colored by FSRS mastery (stability buckets),
// plus due-today / streak / XP and a 7-day review bar chart. Read-only — the
// emotional engine of retention (Math Academy-style knowledge map).
function MasteryView({
  course,
  onOpenSub,
  onReview,
}: {
  course: Course;
  onOpenSub: (moduleId: string, submoduleId: string) => void;
  onReview: () => void;
}) {
  const t = useT();
  const [tree, setTree] = useState<StructureFile | null>(null);
  const [mastery, setMastery] = useState<Record<
    string,
    { stabilityBucket: number; cardCount: number; dueCount: number }
  > | null>(null);
  const [stats, setStats] = useState<{
    reviewedToday: number;
    streakDays: number;
    week: number[];
    xp: number;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([
      invoke<StructureFile>("get_structure", { courseId: course.id }),
      invoke<Record<string, { stabilityBucket: number; cardCount: number; dueCount: number }>>(
        "get_course_mastery",
        { courseId: course.id }
      ),
      invoke<{ reviewedToday: number; streakDays: number; week: number[]; xp: number }>(
        "get_review_stats",
        { courseId: course.id, tzOffsetSecs: tzOffsetSecs() }
      ),
    ]).then(([s, m, st]) => {
      if (cancelled) return;
      if (s.status === "fulfilled") setTree(s.value);
      if (m.status === "fulfilled") setMastery(m.value);
      if (st.status === "fulfilled") setStats(st.value);
    });
    return () => {
      cancelled = true;
    };
  }, [course.id]);

  if (!tree) return <div className="placeholder">{t("loadingStructure")}</div>;
  const dueTotal = Object.values(mastery ?? {}).reduce((a, m) => a + m.dueCount, 0);
  const maxWeek = Math.max(1, ...(stats?.week ?? [0]));
  return (
    <div className="mastery-view">
      <div className="mastery-head">
        <div className="mastery-stat">
          <span className="mastery-stat-num">{dueTotal}</span>
          <span className="mastery-stat-label">{t("masteryDueToday")}</span>
        </div>
        <div className="mastery-stat">
          <span className="mastery-stat-num">{stats?.streakDays ?? 0}</span>
          <span className="mastery-stat-label">{t("masteryStreak")}</span>
        </div>
        <div className="mastery-stat">
          <span className="mastery-stat-num">{stats?.xp ?? 0}</span>
          <span className="mastery-stat-label">XP</span>
        </div>
        <div className="mastery-week" title={t("masteryWeekChart")}>
          {(stats?.week ?? Array(7).fill(0)).map((n, i) => (
            <div
              key={i}
              className="mastery-week-bar"
              style={{ height: `${Math.max(8, (n / maxWeek) * 100)}%` }}
              data-count={n}
            />
          ))}
        </div>
        {dueTotal > 0 && (
          <button className="mastery-review-cta" onClick={onReview}>
            {t("reviewBannerCta")} →
          </button>
        )}
      </div>
      <div className="mastery-legend">
        {[0, 1, 2, 3, 4].map((b) => (
          <span key={b} className="mastery-legend-item">
            <span className={`mastery-dot mastery-${b}`} />
            {t(`masteryBucket${b}` as Parameters<typeof t>[0])}
          </span>
        ))}
      </div>
      <div className="mastery-tree">
        {tree.modules.map((m) => (
          <div key={m.id} className="mastery-module">
            <div className="mastery-module-title">{m.title}</div>
            <ul className="mastery-subs">
              {m.submodules.map((s) => {
                const ms = mastery?.[s.id];
                const bucket = ms?.stabilityBucket ?? 0;
                return (
                  <li key={s.id}>
                    <button className="mastery-sub" onClick={() => onOpenSub(m.id, s.id)}>
                      <span className={`mastery-dot mastery-${bucket}`} />
                      <span className="mastery-sub-title">{s.title}</span>
                      {!!ms?.dueCount && (
                        <span className="mastery-due-chip">{ms.dueCount}</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
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
  const [editStruct, setEditStruct] = useState(false);
  const [estimate, setEstimate] = useState<{
    pending: number;
    lowMinutes: number;
    highMinutes: number;
  } | null>(null);

  // Heuristic wall-clock estimate for the remaining (not-ready) lessons under
  // this course's tier — refreshed whenever the tree changes.
  useEffect(() => {
    if (!tree) {
      setEstimate(null);
      return;
    }
    const pending = tree.modules.reduce(
      (n, m) => n + m.submodules.filter((s) => s.generation_state !== "ready").length,
      0
    );
    if (pending === 0) {
      setEstimate(null);
      return;
    }
    let cancelled = false;
    invoke<{ pending: number; low_minutes: number; high_minutes: number }>(
      "estimate_course_generation",
      { courseId: course.id }
    )
      .then((r) => {
        if (!cancelled)
          setEstimate({ pending: r.pending, lowMinutes: r.low_minutes, highMinutes: r.high_minutes });
      })
      .catch(() => {
        if (!cancelled) setEstimate(null);
      });
    return () => {
      cancelled = true;
    };
  }, [tree, course.id]);

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
    setEditStruct(false);
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
            <button
              type="button"
              className="ghost struct-edit-toggle"
              onClick={() => setEditStruct((v) => !v)}
              aria-expanded={editStruct}
              title={t("editStructure")}
            >
              ✎ {t("editStructure")}
            </button>
            {progress.queued > 0 && (
              <span className="toolbar-note">
                {t("fullCourseQueueStatus", { count: progress.queued })}
              </span>
            )}
            {estimate && estimate.pending > 0 && (
              <span className="toolbar-note">
                {t("genEstimate", {
                  low: estimate.lowMinutes,
                  high: estimate.highMinutes,
                  count: estimate.pending,
                })}
              </span>
            )}
          </div>
          {editStruct ? (
            <StructureEditor
              course={course}
              tree={tree}
              onSaved={async () => {
                setEditStruct(false);
                await reloadTree();
              }}
              onCancel={() => setEditStruct(false)}
            />
          ) : (
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
          )}
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

// Editable course structure: rename / reorder / delete / add modules & lessons.
// Diffs against the live tree via the existing save_structure command (empty id
// = add, omitted = delete + on-disk cleanup). Preserves submodule prereqs.
function StructureEditor({
  course,
  tree,
  onSaved,
  onCancel,
}: {
  course: Course;
  tree: StructureFile;
  onSaved: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const t = useT();
  type ESub = { id: string; title: string; summary: string; prereqs: string[]; state: string };
  type EMod = { id: string; title: string; summary: string; subs: ESub[] };
  const [mods, setMods] = useState<EMod[]>(() =>
    tree.modules.map((m) => ({
      id: m.id,
      title: m.title,
      summary: m.summary || "",
      subs: m.submodules.map((s) => ({
        id: s.id,
        title: s.title,
        summary: s.summary || "",
        prereqs: s.prereqs || [],
        state: s.generation_state,
      })),
    }))
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = (fn: (m: EMod[]) => EMod[]) =>
    setMods((prev) => fn(prev.map((m) => ({ ...m, subs: m.subs.map((s) => ({ ...s })) }))));
  const renameMod = (i: number, title: string) => update((m) => { m[i].title = title; return m; });
  const renameSub = (i: number, j: number, title: string) => update((m) => { m[i].subs[j].title = title; return m; });
  const moveMod = (i: number, d: number) => update((m) => { const j = i + d; if (j < 0 || j >= m.length) return m; const [x] = m.splice(i, 1); m.splice(j, 0, x); return m; });
  const moveSub = (i: number, j: number, d: number) => update((m) => { const subs = m[i].subs; const k = j + d; if (k < 0 || k >= subs.length) return m; const [x] = subs.splice(j, 1); subs.splice(k, 0, x); return m; });
  const delMod = (i: number) => { if (!window.confirm(t("structDeleteConfirm"))) return; update((m) => { m.splice(i, 1); return m; }); };
  const delSub = (i: number, j: number) => {
    // Don't delete a lesson whose background generation job is still running —
    // the in-flight job would recreate its dir right after save_structure removes it.
    if (mods[i]?.subs[j]?.state === "generating") return;
    if (!window.confirm(t("structDeleteConfirm"))) return;
    update((m) => { m[i].subs.splice(j, 1); return m; });
  };
  const addMod = () => update((m) => [...m, { id: "", title: "", summary: "", subs: [] }]);
  const addSub = (i: number) => update((m) => { m[i].subs.push({ id: "", title: "", summary: "", prereqs: [], state: "pending" }); return m; });

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      // Prereqs are stored as submodule TITLES; drop any that no longer match a
      // kept lesson so renames/deletes don't leave dangling references.
      const keptTitles = new Set(
        mods.flatMap((m) => m.subs.map((s) => s.title.trim()).filter(Boolean))
      );
      const modules = mods
        .filter((m) => m.title.trim())
        .map((m) => ({
          id: m.id,
          title: m.title.trim(),
          summary: m.summary,
          prereqs: [] as string[],
          submodules: m.subs
            .filter((s) => s.title.trim())
            .map((s) => ({
              id: s.id,
              title: s.title.trim(),
              summary: s.summary,
              prereqs: s.prereqs.filter((p) => keptTitles.has(p.trim())),
              submodules: [] as unknown[],
            })),
        }));
      await invoke("save_structure", { courseId: course.id, modules });
      await onSaved();
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  };

  return (
    <div className="struct-editor">
      <div className="struct-editor-head">
        <span className="struct-editor-title">✎ {t("editStructure")}</span>
        <span className="sub-actions-spacer" />
        <button className="ghost" onClick={onCancel} disabled={saving}>{t("structCancel")}</button>
        <button className="le-save" onClick={save} disabled={saving}>
          {saving ? t("editorSaving") : t("structSave")}
        </button>
      </div>
      {error && <div className="le-error">{error}</div>}
      <ol className="struct-edit-modules">
        {mods.map((m, i) => (
          <li key={i} className="struct-edit-module">
            <div className="struct-edit-row">
              <span className="num">{i + 1}.</span>
              <input className="struct-edit-input" placeholder={t("structModuleTitle")} value={m.title} onChange={(e) => renameMod(i, e.target.value)} />
              {m.id === "" && <span className="struct-new-badge">{t("structNew")}</span>}
              <button title={t("blockUp")} disabled={i === 0} onClick={() => moveMod(i, -1)}>↑</button>
              <button title={t("blockDown")} disabled={i === mods.length - 1} onClick={() => moveMod(i, 1)}>↓</button>
              <button className="le-del" title={t("blockDelete")} onClick={() => delMod(i)}>✕</button>
            </div>
            <ol className="struct-edit-subs">
              {m.subs.map((s, j) => (
                <li key={j} className="struct-edit-sub">
                  <span className="num">{i + 1}.{j + 1}</span>
                  <input className="struct-edit-input" placeholder={t("structLessonTitle")} value={s.title} onChange={(e) => renameSub(i, j, e.target.value)} />
                  {s.id === "" && <span className="struct-new-badge">{t("structNew")}</span>}
                  <button title={t("blockUp")} disabled={j === 0} onClick={() => moveSub(i, j, -1)}>↑</button>
                  <button title={t("blockDown")} disabled={j === m.subs.length - 1} onClick={() => moveSub(i, j, 1)}>↓</button>
                  <button className="le-del" title={t("blockDelete")} disabled={s.state === "generating"} onClick={() => delSub(i, j)}>✕</button>
                </li>
              ))}
              <li>
                <button className="struct-add" onClick={() => addSub(i)}>＋ {t("structAddLesson")}</button>
              </li>
            </ol>
          </li>
        ))}
      </ol>
      <button className="struct-add" onClick={addMod}>＋ {t("structAddModule")}</button>
      <div className="struct-edit-note">{t("structEditNote")}</div>
    </div>
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

type Flashcard = {
  front: string;
  back: string;
};

type SubmoduleContent = {
  article: string;
  widgets: Record<string, WidgetData>;
  sources: Source[];
  test: TestQuestion[];
  flashcards?: Flashcard[];
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
      // Templated widgets: `template` + `params` (rendered natively).
      template?: string;
      params?: any;
      // Legacy free-form widgets: raw code rendered in a sandboxed iframe.
      html?: string;
      css?: string;
      js?: string;
      height?: number;
      error?: string;
    }
  | { type: "checkpoint"; question: string; answer: string }
  | { type: string; [k: string]: any };

type LightboxImage = {
  key: string;
  src: string;
  caption?: string;
  sourceHref?: string;
  generated?: boolean;
};

type Source = { title: string; url: string; dead?: boolean };

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

type AssistantMsg = {
  role: "user" | "assistant";
  text: string;
  fragment?: string;
  image?: string;
  widgetRef?: { type: string; summary: string };
};

// A widget the learner targeted ("✦ Ask") — focuses the assistant on it.
type AssistantTarget = {
  widgetId: string;
  widgetType: string;
  summary: string;
  imagePath?: string;
};
// Seed for Socratic mode: the exercise the learner got wrong. `correct` is
// passed to the model but never shown in the visible chat.
type SocraticSeed = {
  question: string;
  learnerAnswer: string;
  correct?: string;
  concept?: string;
};
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
  target,
  onTargetConsumed,
  socraticSeed,
  onSocraticConsumed,
  onChanged,
  onOpenSubmodule,
}: {
  courseId: string;
  moduleId: string;
  submoduleId: string;
  target?: AssistantTarget | null;
  onTargetConsumed?: () => void;
  socraticSeed?: SocraticSeed | null;
  onSocraticConsumed?: () => void;
  onChanged?: () => void | Promise<void>;
  onOpenSubmodule: (moduleId: string, submoduleId: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"chat" | "notes">("chat");
  const [messages, setMessages] = useState<AssistantMsg[]>([]);
  const [input, setInput] = useState("");
  const [fragment, setFragment] = useState<string | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [widgetTarget, setWidgetTarget] = useState<AssistantTarget | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<ImageCandidate[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<{ text: string; x: number; y: number } | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [saved, setSaved] = useState(false);
  const [currentNoteId, setCurrentNoteId] = useState<string | null>(null);
  const [socratic, setSocratic] = useState(false);
  const [exercise, setExercise] = useState<SocraticSeed | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  function newChat() {
    setMessages([]);
    setInput("");
    setFragment(null);
    setImage(null);
    setWidgetTarget(null);
    setCandidates([]);
    setError(null);
    setCurrentNoteId(null);
    setExercise(null);
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

  // Consume a Socratic seed (the learner clicked "Разобраться" on a wrong
  // answer): start a fresh guided thread. The correct answer goes only to the
  // model, never into the visible chat.
  useEffect(() => {
    if (!socraticSeed) return;
    const seed = socraticSeed;
    onSocraticConsumed?.();
    setMode("chat");
    setOpen(true);
    setSocratic(true);
    setExercise(seed);
    setFragment(null);
    setImage(null);
    setWidgetTarget(null);
    setCandidates([]);
    setCurrentNoteId(null);
    setError(null);
    const intro = t("socraticAutoIntro");
    setMessages([{ role: "user", text: intro }]);
    setBusy(true);
    invoke<string>("ask_course_assistant", {
      courseId,
      moduleId,
      submoduleId,
      question: intro,
      fragment: null,
      imagePath: null,
      widgetId: null,
      history: [],
      socratic: true,
      exercise: seed,
      exchangeCount: 0,
    })
      .then((answer) =>
        setMessages((prev) => [...prev, { role: "assistant", text: answer || "…" }])
      )
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socraticSeed]);

  // Consume a widget target ("✦ Ask"): open the panel focused on that widget.
  // Reset any prior candidate grid so it can't be applied to the new target. We
  // do NOT attach the image here — the backend re-derives an image widget's local
  // file for vision from its url, which avoids a duplicate image chip and avoids
  // leaking a previous photo onto a non-image target.
  useEffect(() => {
    if (!target) return;
    setMode("chat");
    setOpen(true);
    setWidgetTarget(target);
    setCandidates([]);
    onTargetConsumed?.();
  }, [target, onTargetConsumed]);

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

  async function send(overrideQ?: string) {
    const q = (overrideQ ?? input).trim();
    if ((!q && !image && !widgetTarget) || busy || actionBusy) return;
    const userMsg: AssistantMsg = {
      role: "user",
      text: q,
      fragment: fragment ?? undefined,
      image: image ?? undefined,
      widgetRef: widgetTarget
        ? { type: widgetTarget.widgetType, summary: widgetTarget.summary }
        : undefined,
    };
    const history = messages.map((m) => ({ role: m.role, text: m.text }));
    const wid = widgetTarget?.widgetId ?? null;
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setFragment(null);
    setImage(null);
    setWidgetTarget(null);
    setBusy(true);
    setError(null);
    try {
      const answer = await invoke<string>("ask_course_assistant", {
        courseId,
        moduleId,
        submoduleId,
        question: q || "(see the attached widget)",
        fragment: userMsg.fragment ?? null,
        imagePath: userMsg.image ?? null,
        widgetId: wid,
        history,
        socratic,
        exercise,
        exchangeCount: messages.filter((m) => m.role === "assistant").length,
      });
      setMessages((prev) => [...prev, { role: "assistant", text: answer || "…" }]);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  // ── Per-widget actions on the current target (fix / variants) ──────────────
  function targetArgs() {
    if (!widgetTarget) return null;
    return { courseId, moduleId, submoduleId, widgetId: widgetTarget.widgetId };
  }
  function note(text: string) {
    setMessages((prev) => [...prev, { role: "assistant", text }]);
  }
  async function fixTarget() {
    const args = targetArgs();
    if (!args || actionBusy) return;
    setActionBusy("fix");
    setError(null);
    try {
      const updated = await invoke<{ error?: string | null } | null>("fix_widget", {
        ...args,
        instruction: input.trim() || null,
      });
      setInput("");
      if (updated?.error) {
        note(t("widgetFixPartial", { error: String(updated.error) }));
      } else if (widgetTarget?.widgetType === "diagram") {
        // The diagram is validated only heuristically here; the real Mermaid
        // parser runs in the reader, so don't over-claim success.
        note(t("widgetFixRegenerated"));
      } else {
        note(t("widgetFixDone"));
      }
      await onChanged?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setActionBusy(null);
    }
  }
  async function searchTarget() {
    const args = targetArgs();
    if (!args || actionBusy) return;
    setActionBusy("search");
    setError(null);
    setCandidates([]);
    try {
      const cands = await invoke<ImageCandidate[]>("search_widget_candidates", args);
      setCandidates(cands);
      if (!cands.length) note(t("widgetNotFound"));
    } catch (e) {
      setError(String(e));
    } finally {
      setActionBusy(null);
    }
  }
  async function pickCandidate(c: ImageCandidate) {
    const args = targetArgs();
    if (!args || actionBusy) return;
    setActionBusy("pick");
    setError(null);
    try {
      await invoke("set_widget_image", { ...args, url: c.url, source: c.source || null });
      setCandidates([]);
      note(t("widgetImageUpdated"));
      await onChanged?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setActionBusy(null);
    }
  }
  async function generateTarget() {
    const args = targetArgs();
    if (!args || actionBusy) return;
    setActionBusy("generate");
    setError(null);
    try {
      await invoke("generate_widget_image", args);
      note(t("widgetImageUpdated"));
      await onChanged?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setActionBusy(null);
    }
  }
  // Assistant-proposed deep-dive: append extra sections to the current lesson.
  async function goDeeper() {
    if (actionBusy || busy) return;
    setActionBusy("deepen");
    setError(null);
    try {
      await invoke("extend_submodule", {
        courseId,
        moduleId,
        submoduleId,
        instruction: input.trim() || null,
      });
      setInput("");
      note(t("assistantDeepenDone"));
      await onChanged?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setActionBusy(null);
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
              {mode === "chat" && (
                <button
                  className={`assistant-save socratic-chip${socratic ? " active" : ""}`}
                  onClick={() => setSocratic((s) => !s)}
                  title={t("socraticToggleHint")}
                >
                  🦉 {t("socraticToggle")}
                </button>
              )}
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
                    {m.widgetRef && (
                      <div className="assistant-frag assistant-frag-widget">✦ {m.widgetRef.summary}</div>
                    )}
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
              {widgetTarget && (
                <div className="assistant-frag-chip assistant-target-chip">
                  <span>✦ {widgetTarget.summary}</span>
                  <button
                    onClick={() => {
                      setWidgetTarget(null);
                      setCandidates([]);
                    }}
                    aria-label="remove"
                  >
                    ✕
                  </button>
                </div>
              )}
              {widgetTarget && (
                <div className="assistant-actions">
                  {(widgetTarget.widgetType === "diagram" ||
                    widgetTarget.widgetType === "interactive") && (
                    <button disabled={!!actionBusy} onClick={fixTarget}>
                      {actionBusy === "fix" ? `… ${t("assistantThinking")}` : `🔧 ${t("widgetFix")}`}
                    </button>
                  )}
                  {widgetTarget.widgetType === "image" && (
                    <>
                      <button disabled={!!actionBusy} onClick={searchTarget}>
                        {actionBusy === "search"
                          ? `… ${t("assistantThinking")}`
                          : `🖼 ${t("widgetOtherImages")}`}
                      </button>
                      <button disabled={!!actionBusy} onClick={generateTarget}>
                        {actionBusy === "generate"
                          ? `… ${t("assistantThinking")}`
                          : `✨ ${t("widgetGenerateNew")}`}
                      </button>
                    </>
                  )}
                </div>
              )}
              {candidates.length > 0 && (
                <div className="assistant-candidates">
                  {candidates.map((c, i) => (
                    <button
                      key={i}
                      className="assistant-candidate"
                      disabled={!!actionBusy}
                      onClick={() => pickCandidate(c)}
                      title={c.title}
                    >
                      <img src={c.thumbnail || c.url} alt="" />
                    </button>
                  ))}
                </div>
              )}
              {!widgetTarget && (
                <div className="assistant-actions">
                  <button disabled={!!actionBusy || busy} onClick={goDeeper} title={t("assistantDeepenHint")}>
                    {actionBusy === "deepen" ? `… ${t("assistantThinking")}` : `✦ ${t("assistantDeepen")}`}
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
                  onClick={() => send()}
                  disabled={(!input.trim() && !image && !widgetTarget) || busy || !!actionBusy}
                  title={t("assistantSend")}
                  aria-label={t("assistantSend")}
                >
                  {busy ? "…" : "↑"}
                </button>
              </div>
              {socratic && (
                <div className="socratic-hint-row">
                  <span>{t("socraticHint")}</span>
                  <button
                    className="socratic-show-answer"
                    disabled={busy || !!actionBusy || messages.length === 0}
                    onClick={() => send(t("socraticShowAnswerMsg"))}
                  >
                    {t("socraticShowAnswer")}
                  </button>
                </div>
              )}
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
  const [cardsBusy, setCardsBusy] = useState(false);
  const [editImages, setEditImages] = useState(false);
  const [editing, setEditing] = useState(false);
  const editingRef = useRef(false);
  editingRef.current = editing;
  const [assistantTarget, setAssistantTarget] = useState<AssistantTarget | null>(null);
  const [socraticSeed, setSocraticSeed] = useState<SocraticSeed | null>(null);
  const [recallCards, setRecallCards] = useState<Record<string, SubCard>>({});
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
    // SRS state for in-lesson recall widgets (non-fatal if missing).
    try {
      const cards = await invoke<SubCard[]>("get_submodule_cards", { submoduleId });
      setRecallCards(Object.fromEntries(cards.map((c) => [c.id, c])));
    } catch {
      setRecallCards({});
    }
  }, [course, moduleId, submoduleId]);

  useEffect(() => {
    setContent(null);
    setError(null);
    setRetryingImages(false);
    setImageRetryError(null);
    setEditing(false);
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
        // Never reload content out from under an open editor — it would remount
        // the reader and discard unsaved edits. The editor reloads on save/exit.
        if (editingRef.current) return;
        setRetryingImages(false);
        setImageRetryError(null);
        setCardsBusy(false);
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
  // Soft prerequisites (non-linear courses): unmet earlier submodules, matched by
  // title across the tree. Non-blocking — a hint with links, never a hard lock.
  const prereqLinks = (sub.prereqs ?? [])
    .map((title) => {
      const norm = title.trim().toLowerCase();
      for (const m of tree!.modules) {
        for (const s of m.submodules) {
          if (s.id !== submoduleId && s.title.trim().toLowerCase() === norm) {
            return { moduleId: m.id, submoduleId: s.id, title: s.title, passed: !!s.test_passed };
          }
        }
      }
      return null;
    })
    .filter((x): x is { moduleId: string; submoduleId: string; title: string; passed: boolean } =>
      !!x && !x.passed
    );

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

  // Build an assistant target from a widget the learner clicked "✦ Ask" on.
  function askWidget(widgetId: string) {
    const w = (content?.widgets as Record<string, any> | undefined)?.[widgetId];
    if (!w) return;
    const type: string = w.type || "widget";
    const raw =
      w.description || w.caption || w.title || w.alt || (Array.isArray(w.items) ? w.items[0]?.description : "") || type;
    const summary = `${type} · ${String(raw).replace(/\s+/g, " ").trim().slice(0, 60)}`;
    let imagePath: string | undefined;
    if (type === "image" && typeof w.url === "string" && (w.url.startsWith("/") || w.url.startsWith("file://"))) {
      imagePath = w.url.replace(/^file:\/\//, "");
    }
    setAssistantTarget({ widgetId, widgetType: type, summary, imagePath });
  }

  return (
    <div className="submodule-view">
      {course && (
        <CourseAssistant
          courseId={course.id}
          moduleId={moduleId}
          submoduleId={submoduleId}
          target={assistantTarget}
          onTargetConsumed={() => setAssistantTarget(null)}
          socraticSeed={socraticSeed}
          onSocraticConsumed={() => setSocraticSeed(null)}
          onChanged={reloadContent}
          onOpenSubmodule={onOpenSubmodule}
        />
      )}
      <div className="sub-numbering">
        {moduleIdx + 1}.{subIdx + 1}
        {sub.test_passed && <span className="learned-badge">✓ {t("subLearned")}</span>}
      </div>
      <h1 className="sub-h1">{sub.title}</h1>
      {sub.summary && <div className="sub-lead">{sub.summary}</div>}
      {prereqLinks.length > 0 && (
        <div className="sub-prereq-hint">
          <span className="sub-prereq-label">{t("prereqHint")}</span>{" "}
          {prereqLinks.map((p, i) => (
            <span key={p.submoduleId}>
              {i > 0 && ", "}
              <button
                className="sub-prereq-link"
                onClick={() => onOpenSubmodule(p.moduleId, p.submoduleId)}
              >
                {p.title}
              </button>
            </span>
          ))}
        </div>
      )}

      {editing && (
        <LessonEditor
          courseId={course.id}
          moduleId={moduleId}
          submoduleId={submoduleId}
          initialArticle={content?.article ?? ""}
          initialWidgets={(content?.widgets as Record<string, WidgetData>) ?? {}}
          canGenerate={canGenerate}
          wasPending={state !== "ready"}
          onClose={async () => {
            setEditing(false);
            await reloadTree();
            await reloadContent();
          }}
        />
      )}

      {!editing && (state === "pending" || state === "queued" || state === "failed") && (
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
          <div className="sub-empty-actions">
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
            {state !== "queued" && (
              <button className="ghost" onClick={() => setEditing(true)}>
                ✎ {t("editorWriteManually")}
              </button>
            )}
          </div>
          {error && <p className="error-banner">{t("errorPrefix", { error })}</p>}
        </div>
      )}

      {!editing && state === "generating" && (
        <div className="sub-generating">
          <StageStrip current={stageDetail?.stage ?? "draft"} />
          <LiveActivity stageDetail={stageDetail} />
          <AgentTranscript transcript={transcript} />
        </div>
      )}

      {!editing && state === "ready" && (
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
            {content && !isPodcast && (
              <button
                className="sub-edit-toggle"
                onClick={() => setEditing(true)}
                disabled={enriching}
                title={enriching ? t("editLessonBusy") : t("editLessonHint")}
              >
                ✎ {t("editLesson")}
              </button>
            )}
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
                <div className="sub-image-edit">
                  {!editImages ? (
                    <button
                      className="sub-image-edit-toggle"
                      onClick={() => setEditImages(true)}
                    >
                      ✎ {t("editImages", { count: unresolvedImages })}
                    </button>
                  ) : (
                    <>
                      <button
                        className="sub-image-edit-toggle"
                        onClick={() => setEditImages(false)}
                      >
                        {t("editImagesDone")}
                      </button>
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
                      {imageRetryError && (
                        <span className="sub-recovery-error">
                          {t("errorPrefix", { error: imageRetryError })}
                        </span>
                      )}
                    </>
                  )}
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
                        editImages,
                        recallCards,
                        onAskWidget: askWidget,
                        onChanged: reloadContent,
                      }
                    : undefined
                }
              />
              {content.sources?.length > 0 && (
                <SourcesList sources={content.sources} />
              )}
              {content.test?.length > 0 && (
                <TestSection
                  questions={content.test}
                  alreadyPassed={!!sub.test_passed}
                  recall={isPodcast}
                  onResult={async (ratio, results, passed, weakConcepts) => {
                    await invoke("submit_test_result", {
                      submoduleId,
                      ratio,
                      results,
                      passed,
                      weakConcepts,
                    });
                    if (passed) await reloadTree();
                  }}
                  onSocratic={setSocraticSeed}
                />
              )}
              {content.flashcards && content.flashcards.length > 0 ? (
                <FlashcardDeck cards={content.flashcards} />
              ) : (
                state === "ready" &&
                !enriching && (
                  <div className="flashcards-empty">
                    <button
                      className="flashcards-generate"
                      disabled={cardsBusy}
                      onClick={async () => {
                        if (!course) return;
                        setCardsBusy(true);
                        try {
                          await invoke("start_generate_flashcards", {
                            courseId: course.id,
                            moduleId,
                            submoduleId,
                          });
                        } catch (e) {
                          console.error("start_generate_flashcards failed", e);
                          setCardsBusy(false);
                        }
                      }}
                    >
                      {cardsBusy ? (
                        <>
                          <span className="spinner" /> {t("flashcardsGenerating")}
                        </>
                      ) : (
                        t("flashcardsGenerate")
                      )}
                    </button>
                  </div>
                )
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

// Markdown + LaTeX renderer (same stack as the article) — used for homework
// answers so learners can write math with $…$ / $$…$$.
function MathMarkdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex, [rehypeHighlight, { detect: true, ignoreMissing: true }]]}
    >
      {children}
    </ReactMarkdown>
  );
}

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
          {text.trim() && (
            <div className="assignment-preview">
              <div className="assignment-preview-label">{t("assignmentPreview")}</div>
              <div className="assignment-preview-body assignment-bubble-md">
                <MathMarkdown>{text}</MathMarkdown>
              </div>
            </div>
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
        {turn.text && (
          <div className="assignment-bubble-text assignment-bubble-md">
            <MathMarkdown>{turn.text}</MathMarkdown>
          </div>
        )}
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
  // When false, unresolved image/gallery placeholders are hidden from the reader;
  // the "Edit images" toggle flips this on to expose the editable placeholders.
  editImages: boolean;
  // SRS state for in-lesson recall widgets, keyed by card id.
  recallCards?: Record<string, SubCard>;
  // Open the assistant focused on a specific widget (ask / fix / variants).
  onAskWidget: (widgetId: string) => void;
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

// ===========================================================================
// Course editor — a "block editor" over the existing article.md + widgets.json.
// Blocks are exactly the segments the marker parser yields (text segment or
// widget). Editing is tucked behind a discreet pencil in the lesson toolbar.
// ===========================================================================

const TABLE_TEMPLATE = "\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n";

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

type EditorBlock =
  | { kind: "md"; bid: string; text: string }
  | { kind: "widget"; bid: string; id: string; wtype: string; raw?: string };

let __editorBidSeq = 0;
function nextBid(): string {
  __editorBidSeq += 1;
  return `eb${__editorBidSeq}`;
}

// Char-offset ranges of fenced code blocks so a `::widget` line inside a code
// sample is never mistaken for a real widget marker.
function fencedRanges(md: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let inFence = false;
  let fenceChar = "";
  let start = 0;
  let offset = 0;
  for (const line of md.split("\n")) {
    const fm = /^\s*(```+|~~~+)/.exec(line);
    if (fm) {
      const ch = fm[1][0];
      if (!inFence) {
        inFence = true;
        fenceChar = ch;
        start = offset;
      } else if (ch === fenceChar) {
        inFence = false;
        ranges.push([start, offset + line.length]);
      }
    }
    offset += line.length + 1; // +1 for the "\n" consumed by split
  }
  if (inFence) ranges.push([start, md.length]);
  return ranges;
}

// Editor-only parser. Byte-exact partition: text segments keep their own
// newlines verbatim and each widget keeps its raw marker line. Leaves the
// reader's splitWidgetMarkers untouched.
function parseArticleBlocks(article: string, widgets: Record<string, any>): EditorBlock[] {
  const md = article ?? "";
  const fences = fencedRanges(md);
  const inFence = (i: number) => fences.some(([a, b]) => i >= a && i < b);
  const out: EditorBlock[] = [];
  const pushMd = (text: string) => {
    if (text.length) out.push({ kind: "md", bid: nextBid(), text });
  };
  const re = /^::widget\{([^}]+)\}[ \t]*$/gm;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md))) {
    if (inFence(m.index)) continue;
    pushMd(md.slice(last, m.index));
    const id = /id="([^"]+)"/.exec(m[1])?.[1] ?? "unknown";
    const w = widgets[id];
    const wtype =
      (w && typeof w.type === "string" && w.type) ||
      /type="?([a-zA-Z]+)"?/.exec(m[1])?.[1] ||
      "widget";
    // Trim any trailing spaces/tabs the editor regex tolerated but the reader's
    // marker regex does not, so a re-emitted marker always parses for readers.
    out.push({ kind: "widget", bid: nextBid(), id, wtype, raw: m[0].replace(/[ \t]+$/, "") });
    last = m.index + m[0].length;
  }
  pushMd(md.slice(last));
  if (out.length === 0) out.push({ kind: "md", bid: nextBid(), text: "" });
  return out;
}

function widgetMarkerLine(id: string, wtype: string): string {
  return `::widget{type="${wtype}" id="${id}"}`;
}

// Blocks → article markdown. Every widget marker must occupy its own line so the
// reader's line-anchored regex re-mounts it. We guarantee a newline before the
// marker and a single newline after it — unless the following md block already
// begins with one, or this is the last block. For an UNCHANGED article both
// guards are no-ops (preceding slice ends in "\n", following slice starts with
// "\n"), so the round-trip stays byte-exact; reorder/insert that break those
// invariants get the separators they need instead of gluing markers to text.
function serializeBlocks(blocks: EditorBlock[]): string {
  let out = "";
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.kind === "md") {
      out += b.text;
      continue;
    }
    const marker = b.raw ?? widgetMarkerLine(b.id, b.wtype);
    if (out.length && !out.endsWith("\n")) out += "\n";
    out += marker;
    const next = blocks[i + 1];
    const nextStartsWithNl = !!next && next.kind === "md" && next.text.startsWith("\n");
    if (next && !nextStartsWithNl) out += "\n";
  }
  return out;
}

function newWidgetId(wtype: string, widgets: Record<string, any>): string {
  let id = "";
  do {
    id = `usr-${wtype}-${crypto.randomUUID().slice(0, 8)}`;
  } while (widgets[id]);
  return id;
}

function defaultWidget(kind: string): any {
  switch (kind) {
    case "image":
      return { type: "image", placeholder: true, description: "" };
    case "video":
      return { type: "video", url: "", title: "" };
    case "diagram":
      return { type: "diagram", source: "", caption: "" };
    case "interactive":
      // New interactive blocks are template widgets (free-form HTML is legacy).
      return {
        type: "interactive",
        template: "quiz",
        title: "",
        description: "",
        params: { items: [{ question: "", options: ["", ""], correct: 0 }] },
      };
    case "checkpoint":
      return { type: "checkpoint", question: "", answer: "" };
    case "recall":
      // No card_id yet: the backend mints the SRS card when the lesson saves.
      return { type: "recall", front: "", back: "" };
    default:
      return { type: kind };
  }
}

// A single text block: click-to-edit. When focused, a markdown textarea with an
// insert toolbar, a debounced live preview, and AI-edit-on-selection.
function LeTextBlock({
  text,
  focused,
  onFocus,
  onChange,
  courseId,
}: {
  text: string;
  focused: boolean;
  onFocus: () => void;
  onChange: (t: string) => void;
  courseId: string;
}) {
  const t = useT();
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [sel, setSel] = useState<{ start: number; end: number }>({ start: 0, end: 0 });
  const [ai, setAi] = useState<null | {
    start: number;
    end: number;
    original: string;
    instruction: string;
    busy: boolean;
    result: string | null;
    error: string | null;
  }>(null);
  const preview = useDebounced(text, 200);

  useEffect(() => {
    const ta = taRef.current;
    if (ta && focused) {
      ta.style.height = "auto";
      ta.style.height = `${ta.scrollHeight}px`;
    }
  }, [text, focused]);

  if (!focused) {
    return (
      <div className="le-md-view" onClick={onFocus} role="button" tabIndex={0}>
        {text.trim() ? (
          <MathMarkdown>{text}</MathMarkdown>
        ) : (
          <span className="le-empty">{t("editorEmptyBlock")}</span>
        )}
      </div>
    );
  }

  const updateSel = () => {
    const ta = taRef.current;
    if (ta) setSel({ start: ta.selectionStart, end: ta.selectionEnd });
  };
  const insertAtCursor = (before: string, after = "", placeholder = "") => {
    const ta = taRef.current;
    if (!ta) return;
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    const chosen = text.slice(s, e) || placeholder;
    const next = text.slice(0, s) + before + chosen + after + text.slice(e);
    onChange(next);
    requestAnimationFrame(() => {
      const pos = s + before.length + chosen.length + after.length;
      ta.focus();
      ta.setSelectionRange(pos, pos);
    });
  };
  const hasSel = sel.end > sel.start;

  const runAi = async () => {
    if (!ai || !ai.instruction.trim()) return;
    setAi({ ...ai, busy: true, error: null });
    try {
      const out = await invoke<string>("edit_text", {
        courseId,
        selection: ai.original,
        instruction: ai.instruction,
        context: text.slice(0, 4000),
      });
      setAi((a) => (a ? { ...a, busy: false, result: out } : a));
    } catch (err) {
      setAi((a) => (a ? { ...a, busy: false, error: String(err) } : a));
    }
  };
  const acceptAi = () => {
    if (!ai || ai.result == null) return;
    let next: string;
    if (text.slice(ai.start, ai.end) === ai.original) {
      next = text.slice(0, ai.start) + ai.result + text.slice(ai.end);
    } else {
      const idx = text.indexOf(ai.original);
      next =
        idx >= 0
          ? text.slice(0, idx) + ai.result + text.slice(idx + ai.original.length)
          : text;
    }
    onChange(next);
    setAi(null);
  };

  const quick: Array<{ k: string; label: string }> = [
    { k: "s", label: t("aiSimplify") },
    { k: "e", label: t("aiExpand") },
    { k: "f", label: t("aiFix") },
    { k: "t", label: t("aiTranslate") },
  ];

  return (
    <div className="le-text-edit">
      <div className="le-toolbar">
        <button title={t("fmtBold")} onMouseDown={(e) => e.preventDefault()} onClick={() => insertAtCursor("**", "**", t("fmtBold"))}><b>B</b></button>
        <button title={t("fmtItalic")} onMouseDown={(e) => e.preventDefault()} onClick={() => insertAtCursor("*", "*", t("fmtItalic"))}><i>I</i></button>
        <button title={t("fmtH2")} onMouseDown={(e) => e.preventDefault()} onClick={() => insertAtCursor("## ", "", "")}>H</button>
        <button title={t("fmtLink")} onMouseDown={(e) => e.preventDefault()} onClick={() => insertAtCursor("[", "](https://)", t("fmtLink"))}>🔗</button>
        <button title={t("fmtCode")} onMouseDown={(e) => e.preventDefault()} onClick={() => insertAtCursor("\n```\n", "\n```\n", "")}>{"</>"}</button>
        <button title={t("fmtTable")} onMouseDown={(e) => e.preventDefault()} onClick={() => insertAtCursor(TABLE_TEMPLATE, "", "")}>▦</button>
        <button title={t("fmtFormula")} onMouseDown={(e) => e.preventDefault()} onClick={() => insertAtCursor("$$\n", "\n$$", "")}>∑</button>
        {hasSel && !ai && (
          <button
            className="le-ai-btn"
            onClick={() =>
              setAi({
                start: sel.start,
                end: sel.end,
                original: text.slice(sel.start, sel.end),
                instruction: "",
                busy: false,
                result: null,
                error: null,
              })
            }
          >
            ✦ {t("aiEdit")}
          </button>
        )}
      </div>
      <textarea
        ref={taRef}
        className="le-textarea"
        value={text}
        readOnly={!!ai}
        onChange={(e) => onChange(e.target.value)}
        onSelect={updateSel}
        onKeyUp={updateSel}
        onMouseUp={updateSel}
        autoFocus
      />
      {ai && (
        <div className="le-ai">
          <div className="le-ai-orig">“{ai.original.slice(0, 160)}”</div>
          {ai.result == null ? (
            <>
              <div className="le-ai-quick">
                {quick.map((q) => (
                  <button key={q.k} onClick={() => setAi((a) => (a ? { ...a, instruction: q.label } : a))}>
                    {q.label}
                  </button>
                ))}
              </div>
              <input
                className="le-ai-input"
                placeholder={t("aiEditPlaceholder")}
                value={ai.instruction}
                onChange={(e) => setAi((a) => (a ? { ...a, instruction: e.target.value } : a))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    runAi();
                  }
                }}
              />
              <div className="le-ai-actions">
                <button disabled={!ai.instruction.trim() || ai.busy} onClick={runAi}>
                  {ai.busy ? (
                    <>
                      <span className="spinner" /> {t("aiBusy")}
                    </>
                  ) : (
                    t("aiEditApply")
                  )}
                </button>
                <button className="ghost" onClick={() => setAi(null)}>
                  {t("editorCancel")}
                </button>
              </div>
              {ai.error && <div className="le-ai-error">{ai.error}</div>}
            </>
          ) : (
            <>
              <div className="le-ai-result">
                <MathMarkdown>{ai.result}</MathMarkdown>
              </div>
              <div className="le-ai-actions">
                <button onClick={acceptAi}>{t("aiAccept")}</button>
                <button className="ghost" onClick={() => setAi((a) => (a ? { ...a, result: null } : a))}>
                  {t("aiRetry")}
                </button>
                <button className="ghost" onClick={() => setAi(null)}>
                  {t("aiReject")}
                </button>
              </div>
            </>
          )}
        </div>
      )}
      {!ai && (
        <div className="le-preview">
          <MathMarkdown>{preview}</MathMarkdown>
        </div>
      )}
    </div>
  );
}

// Per-widget editor. Manual fields go into the editor's widgets map (saved
// wholesale); heavy ops (upload / search / generate / AI-fix) run via runHeavy,
// which persists first so the widget exists on disk, then re-reads it back.
function LeWidgetBlock({
  wid,
  widget,
  ctx,
  canGenerate,
  busy,
  onPatch,
  runHeavy,
}: {
  wid: string;
  widget: any;
  ctx: { courseId: string; moduleId: string; submoduleId: string };
  canGenerate: boolean;
  busy: boolean;
  onPatch: (fields: Record<string, any>) => void;
  runHeavy: (op: () => Promise<void>, opts?: { refresh?: boolean }) => Promise<void>;
}) {
  const t = useT();
  const type = widget?.type ?? "widget";
  const [cands, setCands] = useState<
    Array<{ url: string; source?: string; title?: string; thumbnail?: string }>
  >([]);
  const [urlInput, setUrlInput] = useState("");
  const [genDesc, setGenDesc] = useState("");
  const [showCode, setShowCode] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const args = { courseId: ctx.courseId, moduleId: ctx.moduleId, submoduleId: ctx.submoduleId, widgetId: wid };

  if (type === "image") {
    const { imgSrc } = resolveWidgetImage(widget?.url, widget?.source);
    return (
      <figure className="le-widget le-widget-image">
        <div className="le-widget-tag">🖼 {t("blockImage")}</div>
        {imgSrc ? (
          <img className="le-widget-img" src={imgSrc} alt={widget?.alt || ""} />
        ) : (
          <div className="le-img-empty">{t("widgetImageNone")}</div>
        )}
        <div className="le-widget-actions">
          <button
            disabled={busy}
            onClick={() =>
              runHeavy(async () => {
                const sel = await openFileDialog({
                  multiple: false,
                  filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }],
                });
                const path = typeof sel === "string" ? sel : null;
                if (path) await invoke("import_local_image", { ...args, srcPath: path });
              })
            }
          >
            ⤓ {t("widgetImageUpload")}
          </button>
          <button
            disabled={busy}
            onClick={() =>
              runHeavy(
                async () => {
                  const c = await invoke<any[]>("search_widget_candidates", args);
                  setCands((c as any) || []);
                },
                { refresh: false }
              )
            }
          >
            🔍 {t("widgetImageSearch")}
          </button>
          {canGenerate && (
            <button
              disabled={busy}
              onClick={() => runHeavy(async () => { await invoke("generate_widget_image", args); })}
            >
              ✦ {t("widgetImageGenerate")}
            </button>
          )}
        </div>
        <div className="le-url-row">
          <input
            placeholder={t("widgetImageUrl")}
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
          />
          <button
            disabled={busy || !urlInput.trim()}
            onClick={() =>
              runHeavy(async () => {
                await invoke("set_widget_image", { ...args, url: urlInput.trim(), source: null });
                setUrlInput("");
              })
            }
          >
            OK
          </button>
        </div>
        {cands.length > 0 && (
          <div className="le-cands">
            {cands.map((c, i) => (
              <button
                key={i}
                className="le-cand"
                disabled={busy}
                onClick={() =>
                  runHeavy(async () => {
                    await invoke("set_widget_image", { ...args, url: c.url, source: c.source ?? null });
                    setCands([]);
                  })
                }
              >
                <img src={c.thumbnail || c.url} alt={c.title || ""} />
              </button>
            ))}
          </div>
        )}
        <input
          className="le-cap"
          placeholder={t("descriptionLabel")}
          value={widget?.description || ""}
          disabled={busy}
          onChange={(e) => onPatch({ description: e.target.value })}
        />
      </figure>
    );
  }
  if (type === "diagram") {
    return (
      <figure className="le-widget">
        <div className="le-widget-tag">📊 {t("blockDiagram")}</div>
        {widget?.source?.trim() && <DiagramWidget id={wid} widget={widget} />}
        <textarea
          className="le-code"
          placeholder={t("diagramSource")}
          value={widget?.source || ""}
          disabled={busy}
          onChange={(e) => onPatch({ source: e.target.value, error: undefined })}
        />
        <input
          className="le-cap"
          placeholder={t("captionLabel")}
          value={widget?.caption || ""}
          disabled={busy}
          onChange={(e) => onPatch({ caption: e.target.value })}
        />
        <div className="le-gen-row">
          <input
            placeholder={t("genDescribePlaceholder")}
            value={genDesc}
            onChange={(e) => setGenDesc(e.target.value)}
          />
          <button
            disabled={busy || !genDesc.trim()}
            onClick={() =>
              runHeavy(async () => {
                await invoke("fix_widget", { ...args, instruction: genDesc });
                setGenDesc("");
              })
            }
          >
            ✦ {t("widgetGenerate")}
          </button>
        </div>
      </figure>
    );
  }
  if (type === "interactive" && widget?.template) {
    // Template widget: edit params as JSON with validate-on-apply + live preview.
    return (
      <figure className="le-widget">
        <div className="le-widget-tag">
          ⚙ {t("blockInteractive")} · {widget.template}
        </div>
        <input
          className="le-cap"
          placeholder={t("titleLabel")}
          value={widget?.title || ""}
          disabled={busy}
          onChange={(e) => onPatch({ title: e.target.value })}
        />
        <div className="le-gen-row">
          <input
            placeholder={t("genDescribePlaceholder")}
            value={genDesc}
            onChange={(e) => setGenDesc(e.target.value)}
          />
          <button
            disabled={busy || !genDesc.trim()}
            onClick={() =>
              runHeavy(async () => {
                await invoke("fix_widget", { ...args, instruction: genDesc });
                setGenDesc("");
              })
            }
          >
            ✦ {t("widgetGenerate")}
          </button>
        </div>
        <button className="ghost le-toggle" onClick={() => setShowCode((v) => !v)}>
          {showCode ? t("hideCode") : t("tplEditParams")}
        </button>
        {showCode && (
          <TplParamsEditor
            params={widget?.params}
            disabled={busy}
            onApply={(params) => onPatch({ params, error: undefined })}
          />
        )}
        <button className="ghost le-toggle" onClick={() => setShowPreview((v) => !v)}>
          {showPreview ? t("hidePreview") : t("showPreview")}
        </button>
        {showPreview && <TemplateWidget id={wid} widget={widget} />}
      </figure>
    );
  }
  if (type === "interactive") {
    return (
      <figure className="le-widget">
        <div className="le-widget-tag">⚙ {t("blockInteractive")}</div>
        <input
          className="le-cap"
          placeholder={t("titleLabel")}
          value={widget?.title || ""}
          disabled={busy}
          onChange={(e) => onPatch({ title: e.target.value })}
        />
        <div className="le-gen-row">
          <input
            placeholder={t("genDescribePlaceholder")}
            value={genDesc}
            onChange={(e) => setGenDesc(e.target.value)}
          />
          <button
            disabled={busy || !genDesc.trim()}
            onClick={() =>
              runHeavy(async () => {
                await invoke("fix_widget", { ...args, instruction: genDesc });
                setGenDesc("");
              })
            }
          >
            ✦ {t("widgetGenerate")}
          </button>
        </div>
        <button className="ghost le-toggle" onClick={() => setShowCode((v) => !v)}>
          {showCode ? t("hideCode") : t("interactiveEdit")}
        </button>
        {showCode && (
          <>
            <textarea className="le-code" placeholder="HTML" value={widget?.html || ""} disabled={busy} onChange={(e) => onPatch({ html: e.target.value, error: undefined })} />
            <textarea className="le-code" placeholder="CSS" value={widget?.css || ""} disabled={busy} onChange={(e) => onPatch({ css: e.target.value, error: undefined })} />
            <textarea className="le-code" placeholder="JS" value={widget?.js || ""} disabled={busy} onChange={(e) => onPatch({ js: e.target.value, error: undefined })} />
          </>
        )}
        {(widget?.html || "").trim() && (
          <>
            <button className="ghost le-toggle" onClick={() => setShowPreview((v) => !v)}>
              {showPreview ? t("hidePreview") : t("showPreview")}
            </button>
            {showPreview && <InteractiveWidget id={wid} widget={widget} />}
          </>
        )}
      </figure>
    );
  }
  if (type === "video") {
    return (
      <figure className="le-widget">
        <div className="le-widget-tag">▶ {t("blockVideo")}</div>
        <input className="le-cap" placeholder={t("videoUrl")} value={widget?.url || ""} disabled={busy} onChange={(e) => onPatch({ url: e.target.value })} />
        <input className="le-cap" placeholder={t("videoTitle")} value={widget?.title || ""} disabled={busy} onChange={(e) => onPatch({ title: e.target.value })} />
        {(widget?.url || "").trim() && <VideoWidget id={wid} widget={widget} />}
      </figure>
    );
  }
  if (type === "checkpoint") {
    return (
      <figure className="le-widget">
        <div className="le-widget-tag">✓ {t("blockCheckpoint")}</div>
        <textarea className="le-cap" placeholder={t("checkpointQuestion")} value={widget?.question || ""} disabled={busy} onChange={(e) => onPatch({ question: e.target.value })} />
        <textarea className="le-cap" placeholder={t("checkpointAnswer")} value={widget?.answer || ""} disabled={busy} onChange={(e) => onPatch({ answer: e.target.value })} />
      </figure>
    );
  }
  if (type === "recall") {
    return (
      <figure className="le-widget">
        <div className="le-widget-tag">✦ {t("recallLabel")}</div>
        <textarea className="le-cap" placeholder={t("checkpointQuestion")} value={widget?.front || ""} disabled={busy} onChange={(e) => onPatch({ front: e.target.value })} />
        <textarea className="le-cap" placeholder={t("checkpointAnswer")} value={widget?.back || ""} disabled={busy} onChange={(e) => onPatch({ back: e.target.value })} />
      </figure>
    );
  }
  if (type === "gallery") {
    return (
      <figure className="le-widget">
        <div className="le-widget-tag">🖼 {t("blockImage")} ×{Array.isArray(widget?.items) ? widget.items.length : 0}</div>
        <WidgetRenderer id={wid} widget={widget} />
        <input className="le-cap" placeholder={t("captionLabel")} value={widget?.caption || ""} disabled={busy} onChange={(e) => onPatch({ caption: e.target.value })} />
        <div className="le-note">{t("galleryEditNote")}</div>
      </figure>
    );
  }
  return (
    <div className="le-widget le-widget-unknown">
      {type} <span className="widget-id">#{wid}</span>
    </div>
  );
}

function InsertBar({ onInsert }: { onInsert: (k: string) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const items: Array<{ k: string; label: string }> = [
    { k: "text", label: t("blockText") },
    { k: "image", label: t("blockImage") },
    { k: "table", label: t("blockTable") },
    { k: "formula", label: t("blockFormula") },
    { k: "video", label: t("blockVideo") },
    { k: "diagram", label: t("blockDiagram") },
    { k: "interactive", label: t("blockInteractive") },
    { k: "checkpoint", label: t("blockCheckpoint") },
    { k: "recall", label: t("recallLabel") },
  ];
  return (
    <div className="le-insert">
      {open ? (
        <div className="le-insert-menu">
          {items.map((it) => (
            <button key={it.k} onClick={() => { onInsert(it.k); setOpen(false); }}>
              {it.label}
            </button>
          ))}
          <button className="ghost" onClick={() => setOpen(false)}>×</button>
        </div>
      ) : (
        <button className="le-insert-add" onClick={() => setOpen(true)}>
          ＋ {t("editorAddBlock")}
        </button>
      )}
    </div>
  );
}

function LessonEditor({
  courseId,
  moduleId,
  submoduleId,
  initialArticle,
  initialWidgets,
  canGenerate,
  wasPending,
  onClose,
}: {
  courseId: string;
  moduleId: string;
  submoduleId: string;
  initialArticle: string;
  initialWidgets: Record<string, WidgetData>;
  canGenerate: boolean;
  wasPending: boolean;
  onClose: (saved: boolean) => void | Promise<void>;
}) {
  const t = useT();
  const [blocks, setBlocks] = useState<EditorBlock[]>(() =>
    parseArticleBlocks(initialArticle, initialWidgets as Record<string, any>)
  );
  const [widgets, setWidgets] = useState<Record<string, any>>(() => ({ ...(initialWidgets || {}) }));
  const [focusedBid, setFocusedBid] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patchWidget = (id: string, fields: Record<string, any>) => {
    setWidgets((w) => ({ ...w, [id]: { ...(w[id] || {}), ...fields } }));
    setDirty(true);
  };
  const setBlockText = (bid: string, text: string) => {
    setBlocks((bs) => bs.map((b) => (b.bid === bid && b.kind === "md" ? { ...b, text } : b)));
    setDirty(true);
  };
  const moveBlock = (idx: number, delta: number) => {
    setBlocks((bs) => {
      const j = idx + delta;
      if (j < 0 || j >= bs.length) return bs;
      const next = bs.slice();
      const [it] = next.splice(idx, 1);
      next.splice(j, 0, it);
      return next;
    });
    setDirty(true);
  };
  const deleteBlock = (idx: number) => {
    const b = blocks[idx];
    if (b && b.kind === "widget") {
      setWidgets((w) => {
        const n = { ...w };
        delete n[b.id];
        return n;
      });
    }
    setBlocks((bs) => {
      const next = bs.slice();
      next.splice(idx, 1);
      return next.length ? next : [{ kind: "md", bid: nextBid(), text: "" }];
    });
    setDirty(true);
  };
  const insertAt = (idx: number, kind: string) => {
    let block: EditorBlock;
    if (kind === "table") block = { kind: "md", bid: nextBid(), text: TABLE_TEMPLATE };
    else if (kind === "formula") block = { kind: "md", bid: nextBid(), text: "\n$$\n  \n$$\n" };
    else if (kind === "text") block = { kind: "md", bid: nextBid(), text: "" };
    else {
      const id = newWidgetId(kind, widgets);
      setWidgets((m) => ({ ...m, [id]: defaultWidget(kind) }));
      block = { kind: "widget", bid: nextBid(), id, wtype: kind };
    }
    setBlocks((bs) => {
      const next = bs.slice();
      next.splice(idx, 0, block);
      return next;
    });
    if (block.kind === "md") setFocusedBid(block.bid);
    setDirty(true);
  };

  const persist = async () => {
    const article = serializeBlocks(blocks);
    await invoke("save_lesson_content", {
      courseId,
      moduleId,
      submoduleId,
      article,
      widgets,
      markReady: wasPending,
    });
    setDirty(false);
  };
  const refreshWidgets = async () => {
    const c = await invoke<SubmoduleContent>("read_submodule_article", {
      courseId,
      moduleId,
      submoduleId,
    });
    setWidgets({ ...((c.widgets as any) || {}) });
  };
  const runHeavy = async (op: () => Promise<void>, opts?: { refresh?: boolean }) => {
    setBusy(true);
    setError(null);
    try {
      await persist();
      await op();
      if (opts?.refresh !== false) await refreshWidgets();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await persist();
      await onClose(true);
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  };
  const cancel = () => {
    if (dirty && !window.confirm(t("editorExitDirty"))) return;
    onClose(false);
  };

  return (
    <div className="lesson-editor">
      <div className="le-header">
        <span className="le-title">✎ {t("editorTitle")}</span>
        <span className="le-spacer" />
        {busy && (
          <span className="le-busy">
            <span className="spinner" /> {t("aiBusy")}
          </span>
        )}
        <button className="ghost" onClick={cancel} disabled={saving || busy}>
          {t("editorCancel")}
        </button>
        <button className="le-save" onClick={save} disabled={saving || busy}>
          {saving ? (
            <>
              <span className="spinner" /> {t("editorSaving")}
            </>
          ) : (
            t("editorSave")
          )}
        </button>
      </div>
      {error && <div className="le-error">{error}</div>}
      <div className="le-blocks">
        <InsertBar onInsert={(k) => insertAt(0, k)} />
        {blocks.map((b, i) => (
          <div className="le-block" key={b.bid}>
            <div className="le-block-chrome">
              <button title={t("blockUp")} disabled={i === 0} onClick={() => moveBlock(i, -1)}>↑</button>
              <button title={t("blockDown")} disabled={i === blocks.length - 1} onClick={() => moveBlock(i, 1)}>↓</button>
              <button title={t("blockDelete")} className="le-del" onClick={() => deleteBlock(i)}>✕</button>
            </div>
            {b.kind === "md" ? (
              <LeTextBlock
                text={b.text}
                focused={focusedBid === b.bid}
                onFocus={() => setFocusedBid(b.bid)}
                onChange={(text) => setBlockText(b.bid, text)}
                courseId={courseId}
              />
            ) : (
              <LeWidgetBlock
                wid={b.id}
                widget={widgets[b.id]}
                ctx={{ courseId, moduleId, submoduleId }}
                canGenerate={canGenerate}
                busy={busy}
                onPatch={(fields) => patchWidget(b.id, fields)}
                runHeavy={runHeavy}
              />
            )}
            <InsertBar onInsert={(k) => insertAt(i + 1, k)} />
          </div>
        ))}
      </div>
    </div>
  );
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
  let inner: ReactNode;
  if (widget.type === "image") {
    // Hide an unresolved image entirely unless the reader is in "Edit images"
    // mode — a dashed placeholder is noise in a finished article.
    const item = widget as WidgetImageItem;
    const unresolved = item.placeholder === true || !resolveWidgetImage(item.url, item.source).imgSrc;
    if (unresolved && !widgetCtx?.editImages) return null;
    inner = (
      <ImagePlaceholder id={id} widget={widget as any} onOpenImage={onOpenImage} widgetCtx={widgetCtx} />
    );
  } else if (widget.type === "gallery") {
    inner = (
      <GalleryWidget
        id={id}
        widget={widget as any}
        onOpenImage={onOpenImage}
        editImages={!!widgetCtx?.editImages}
      />
    );
  } else if (widget.type === "diagram") inner = <DiagramWidget id={id} widget={widget as any} />;
  else if (widget.type === "video") inner = <VideoWidget id={id} widget={widget as any} />;
  else if (widget.type === "interactive")
    // Templated widgets render natively; legacy free-form code keeps the
    // sandboxed-iframe path.
    inner = (widget as any).template ? (
      <TemplateWidget id={id} widget={widget as any} />
    ) : (
      <InteractiveWidget id={id} widget={widget as any} />
    );
  else if (widget.type === "checkpoint") inner = <CheckpointWidget id={id} widget={widget as any} />;
  else if (widget.type === "recall")
    inner = <RecallWidget id={id} widget={widget as any} widgetCtx={widgetCtx} />;
  else
    inner = (
      <div className="widget widget-unknown">
        {t("widgetUnknown")}: {widget.type} <span className="widget-id">#{id}</span>
      </div>
    );

  // In the editable reader, wrap visual widgets with an "Ask" affordance that
  // focuses the assistant on this widget (ask / fix / other variants).
  const askable = ["image", "gallery", "diagram", "video", "interactive"].includes(widget.type);
  if (widgetCtx && askable) {
    return (
      <div className="widget-host">
        <button
          className="widget-ask"
          title={t("widgetAsk")}
          onClick={() => widgetCtx.onAskWidget(id)}
        >
          ✦ {t("widgetAsk")}
        </button>
        {inner}
      </div>
    );
  }
  return <>{inner}</>;
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

// Tests generate a larger pool than is shown; each attempt draws a fresh random
// subset so a retake isn't the same questions with the answers already revealed.
const TEST_QUESTIONS_PER_ATTEMPT = 6;

function FlashcardDeck({ cards }: { cards: Flashcard[] }) {
  const t = useT();
  const [started, setStarted] = useState(false);
  const [idx, setIdx] = useState(0);
  const [flipped, setFlipped] = useState(false);
  if (!cards.length) return null;
  // Clamp: a shorter deck (e.g. regenerated mid-view) must not index past the end.
  const safeIdx = Math.min(idx, cards.length - 1);
  const card = cards[safeIdx];
  function go(delta: number) {
    setIdx((i) => Math.min(cards.length - 1, Math.max(0, i + delta)));
    setFlipped(false);
  }
  if (!started) {
    return (
      <section className="flashcards">
        <div className="flashcards-header">
          <h3 className="flashcards-title">{t("flashcardsTitle")}</h3>
          <span className="flashcards-progress">
            {t("flashcardsCount", { count: cards.length })}
          </span>
        </div>
        <button
          className="flashcards-start"
          onClick={() => {
            setStarted(true);
            setIdx(0);
            setFlipped(false);
          }}
        >
          {t("flashcardsStart")}
        </button>
      </section>
    );
  }
  return (
    <section className="flashcards">
      <div className="flashcards-header">
        <h3 className="flashcards-title">{t("flashcardsTitle")}</h3>
        <span className="flashcards-progress">
          {safeIdx + 1} / {cards.length}
        </span>
      </div>
      <button
        className={`flashcard${flipped ? " is-flipped" : ""}`}
        onClick={() => setFlipped((f) => !f)}
      >
        <div className="flashcard-face">{flipped ? card.back : card.front}</div>
        <div className="flashcard-hint">
          {flipped ? t("flashcardsShowFront") : t("flashcardsFlip")}
        </div>
      </button>
      <div className="flashcards-nav">
        <button disabled={safeIdx === 0} onClick={() => go(-1)}>
          {t("flashcardsPrev")}
        </button>
        <button disabled={safeIdx >= cards.length - 1} onClick={() => go(1)}>
          {t("flashcardsNext")}
        </button>
      </div>
    </section>
  );
}

function shuffledCopy<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function sampleQuestions(pool: TestQuestion[], n: number): TestQuestion[] {
  const shuffled = shuffledCopy(pool);
  return shuffled.slice(0, Math.min(n, shuffled.length));
}

function TestSection({
  questions,
  alreadyPassed,
  recall,
  onResult,
  onSocratic,
}: {
  questions: TestQuestion[];
  alreadyPassed: boolean;
  recall?: boolean;
  onResult: (
    ratio: number,
    results: boolean[],
    passed: boolean,
    weakConcepts: string[]
  ) => void | Promise<void>;
  onSocratic?: (seed: SocraticSeed) => void;
}) {
  const t = useT();
  const title = recall ? t("recallTitle") : t("testTitle");
  const [started, setStarted] = useState(false);
  const [shown, setShown] = useState<TestQuestion[]>(() =>
    sampleQuestions(questions, TEST_QUESTIONS_PER_ATTEMPT)
  );
  const [answers, setAnswers] = useState<(number | null)[]>(() =>
    shown.map(() => null)
  );
  const [submitted, setSubmitted] = useState(false);

  const correctCount = shown.reduce(
    (n, q, i) => (answers[i] === q.correct ? n + 1 : n),
    0
  );
  const ratio = shown.length > 0 ? correctCount / shown.length : 0;
  const passed = ratio >= TEST_PASS_THRESHOLD;
  const allAnswered = answers.every((a) => a !== null);

  // Fresh random subset for a new attempt — retakes draw different questions.
  function freshAttempt() {
    const s = sampleQuestions(questions, TEST_QUESTIONS_PER_ATTEMPT);
    setShown(s);
    setAnswers(s.map(() => null));
    setSubmitted(false);
  }

  async function submit() {
    setSubmitted(true);
    // Send the real per-question result every attempt so the backend can grade
    // honestly (first attempt drives spaced review); pass also gates progress.
    const results = shown.map((q, i) => answers[i] === q.correct);
    // Concepts the learner missed — drives the first-attempt weak-spot note.
    const weakConcepts = Array.from(
      new Set(
        shown
          .filter((q, i) => answers[i] !== q.correct)
          .map((q) => (q.concept || "").trim())
          .filter(Boolean)
      )
    );
    await onResult(ratio, results, passed, weakConcepts);
  }

  function retake() {
    freshAttempt();
  }

  if (!started) {
    return (
      <section className="test">
        <div className="test-header">
          <h3 className="test-title">{title}</h3>
          {alreadyPassed && <span className="learned-badge">✓ {t("subLearned")}</span>}
        </div>
        <button
          className="test-start"
          onClick={() => {
            freshAttempt();
            setStarted(true);
          }}
        >
          {alreadyPassed ? t("testRetake") : t("testStart")}
        </button>
      </section>
    );
  }

  return (
    <section className="test">
      <div className="test-header">
        <h3 className="test-title">{title}</h3>
      </div>
      <ol className="test-questions">
        {shown.map((q, i) => (
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
            {submitted && answers[i] !== q.correct && onSocratic && (
              <button
                className="socratic-figure-out"
                onClick={() =>
                  onSocratic({
                    question: q.text,
                    learnerAnswer:
                      answers[i] !== null ? q.options[answers[i] as number] : "",
                    correct: q.options[q.correct],
                    concept: q.concept,
                  })
                }
              >
                🦉 {t("socraticFigureOut")}
              </button>
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
            {t("testScore", { correct: correctCount, total: shown.length })}
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

// ===== FSRS review session: flip cards, grade Again/Hard/Good/Easy =====

/** "4 д." / "2 мес." — grade-button interval labels from a day count. */
function fmtInterval(days: number, t: ReturnType<typeof useT>) {
  if (days < 1) return t("gradeIntLessDay");
  if (days < 30) return t("gradeIntDays", { count: Math.round(days) });
  if (days < 365) return t("gradeIntMonths", { count: Math.round(days / 30.4) });
  return t("gradeIntYears", { count: Math.round(days / 365) });
}

/** Shared by ReviewFlipCard and the in-lesson recall widgets. */
function GradeButtons({
  preview,
  suggested,
  disabled,
  onGrade,
}: {
  preview?: { again: number; hard: number; good: number; easy: number };
  suggested?: number | null;
  disabled?: boolean;
  onGrade: (rating: 1 | 2 | 3 | 4) => void;
}) {
  const t = useT();
  const buttons: { rating: 1 | 2 | 3 | 4; cls: string; label: string; days?: number }[] = [
    { rating: 1, cls: "again", label: t("gradeAgain"), days: preview?.again },
    { rating: 2, cls: "hard", label: t("gradeHard"), days: preview?.hard },
    { rating: 3, cls: "good", label: t("gradeGood"), days: preview?.good },
    { rating: 4, cls: "easy", label: t("gradeEasy"), days: preview?.easy },
  ];
  return (
    <div className="grade-row">
      {buttons.map((b) => (
        <button
          key={b.rating}
          className={`grade-btn grade-${b.cls}${suggested === b.rating ? " suggested" : ""}`}
          disabled={disabled}
          onClick={() => onGrade(b.rating)}
        >
          <span className="grade-label">{b.label}</span>
          {b.days !== undefined && (
            <span className="grade-interval">{fmtInterval(b.days, t)}</span>
          )}
        </button>
      ))}
    </div>
  );
}

function ReviewFlipCard({
  card,
  flipped,
  onFlip,
  onGrade,
}: {
  card: DueCard;
  flipped: boolean;
  onFlip: () => void;
  onGrade: (rating: 1 | 2 | 3 | 4, viaAi: boolean) => void;
}) {
  const t = useT();
  const [answer, setAnswer] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [ai, setAi] = useState<{ rating: number; feedback: string } | null>(null);

  async function checkWithAi() {
    setAiBusy(true);
    try {
      const res = await invoke<{ rating: number; feedback: string }>(
        "grade_card_with_ai",
        { cardId: card.id, answer }
      );
      setAi(res);
      if (!flipped) onFlip();
    } catch {
      setAi(null);
    } finally {
      setAiBusy(false);
    }
  }

  return (
    <div className="review-flip">
      <div className="review-flip-crumb">
        {card.courseTitle} · {card.submoduleTitle}
        {card.state === 0 && <span className="review-new-chip">{t("reviewNewBadge")}</span>}
      </div>
      <button
        className={`flashcard review-flashcard${flipped ? " is-flipped" : ""}`}
        onClick={onFlip}
      >
        <div className="flashcard-face">
          <MathMarkdown>{flipped ? card.back : card.front}</MathMarkdown>
        </div>
        <div className="flashcard-hint">
          {flipped ? t("reviewFlipHint") : t("flashcardsFlip")}
        </div>
      </button>
      {!flipped && (
        <div className="ai-check">
          <textarea
            className="ai-check-input"
            placeholder={t("aiCheckPlaceholder")}
            value={answer}
            rows={2}
            onChange={(e) => setAnswer(e.target.value)}
          />
          <button
            className="ai-check-btn"
            disabled={aiBusy || !answer.trim()}
            onClick={checkWithAi}
          >
            {aiBusy ? t("aiCheckBusy") : t("aiCheckButton")}
          </button>
        </div>
      )}
      {flipped && ai && (
        <div className="ai-grade-panel">
          <div className="ai-grade-feedback">{ai.feedback}</div>
          <div className="ai-grade-hint">{t("aiCheckOverrideHint")}</div>
        </div>
      )}
      {flipped && (
        <GradeButtons
          preview={card.preview}
          suggested={ai?.rating ?? null}
          onGrade={(r) => onGrade(r, ai !== null)}
        />
      )}
      {flipped && <div className="grade-safety">{t("gradeSafetyNote")}</div>}
    </div>
  );
}

// Leech flow: a card failed too many times got auto-suspended; offer an
// LLM rewrite into better atomic cards (or leave it paused).
function LeechBanner({ card, onClose }: { card: SrsCard; onClose: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [proposals, setProposals] = useState<
    { front: string; back: string; concept?: string }[] | null
  >(null);
  const [failed, setFailed] = useState(false);

  async function rewrite() {
    setBusy(true);
    setFailed(false);
    try {
      const cards = await invoke<{ front: string; back: string; concept?: string }[]>(
        "rewrite_leech_card",
        { cardId: card.id }
      );
      if (cards.length === 0) setFailed(true);
      else setProposals(cards);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  async function accept() {
    if (!proposals) return;
    setBusy(true);
    try {
      await invoke("replace_card", { cardId: card.id, cards: proposals });
      onClose();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="leech-banner">
      <div className="leech-title">{t("leechSuspended")}</div>
      <div className="leech-card-ref">«{card.front}»</div>
      {proposals === null ? (
        <div className="leech-actions">
          <button className="leech-rewrite" disabled={busy} onClick={rewrite}>
            {busy ? t("leechRewriteBusy") : t("leechRewrite")}
          </button>
          <button className="leech-dismiss" disabled={busy} onClick={onClose}>
            {t("leechKeepPaused")}
          </button>
        </div>
      ) : (
        <>
          <ul className="leech-proposals">
            {proposals.map((c, i) => (
              <li key={i}>
                <span className="leech-p-front">{c.front}</span>
                <span className="leech-p-back">{c.back}</span>
              </li>
            ))}
          </ul>
          <div className="leech-actions">
            <button className="leech-rewrite" disabled={busy} onClick={accept}>
              {t("leechAcceptCards", { count: proposals.length })}
            </button>
            <button className="leech-dismiss" disabled={busy} onClick={onClose}>
              {t("leechKeepPaused")}
            </button>
          </div>
        </>
      )}
      {failed && <div className="leech-failed">{t("leechRewriteFailed")}</div>}
    </div>
  );
}

function ReviewSession({
  courseId,
  onClose,
  onGraded,
}: {
  courseId: string | null;
  onClose: () => void;
  onGraded: () => void | Promise<void>;
}) {
  const t = useT();
  const [queue, setQueue] = useState<DueCard[] | null>(null);
  const [pos, setPos] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [ratings, setRatings] = useState<number[]>([]);
  const [leech, setLeech] = useState<SrsCard | null>(null);
  // Cards whose grade_card failed (offline, lock contention): retried once at
  // session end; per-card modal errors would destroy the flow.
  const failedGrades = useRef<{ cardId: string; rating: number }[]>([]);

  useEffect(() => {
    invoke<DueCard[]>("get_due_cards", {
      courseId,
      tzOffsetSecs: tzOffsetSecs(),
      limit: 100,
    })
      .then((d) => setQueue(d))
      .catch(() => setQueue([]));
  }, [courseId]);

  const grade = useCallback(
    (card: DueCard, rating: 1 | 2 | 3 | 4, viaAi = false) => {
      // Optimistic: advance immediately, persist in the background.
      setRatings((r) => [...r, rating]);
      setFlipped(false);
      setPos((p) => p + 1);
      invoke<GradeOutcome>("grade_card", {
        cardId: card.id,
        rating,
        source: viaAi ? "ai" : "manual",
      })
        .then((out) => {
          if (out.becameLeech) setLeech(out.card);
        })
        .catch(() => {
          failedGrades.current.push({ cardId: card.id, rating });
        });
    },
    []
  );

  // Keyboard: Space flips, 1-4 grades the flipped card.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!queue || pos >= queue.length) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.code === "Space") {
        e.preventDefault();
        setFlipped((f) => !f);
      } else if (flipped && ["1", "2", "3", "4"].includes(e.key)) {
        e.preventDefault();
        grade(queue[pos], Number(e.key) as 1 | 2 | 3 | 4);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [queue, pos, flipped, grade]);

  // Session over: flush failed grades once, then refresh the badge.
  const finished = queue !== null && pos >= queue.length;
  useEffect(() => {
    if (!finished) return;
    const failed = failedGrades.current.splice(0);
    Promise.allSettled(
      failed.map((f) => invoke("grade_card", { cardId: f.cardId, rating: f.rating }))
    ).then(() => onGraded());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finished]);

  if (queue === null) {
    return <div className="placeholder">{t("loadingStructure")}</div>;
  }
  if (queue.length === 0) {
    return (
      <div className="review-done">
        <div className="review-done-icon">✓</div>
        <div className="review-done-title">{t("reviewAllDone")}</div>
        <div className="review-done-sub">{t("reviewSessionEmpty")}</div>
        <button className="test-start" onClick={onClose}>
          {t("reviewBackHome")}
        </button>
      </div>
    );
  }
  if (finished) {
    const counts = [1, 2, 3, 4].map((r) => ratings.filter((x) => x === r).length);
    return (
      <div className="review-done">
        {leech && <LeechBanner card={leech} onClose={() => setLeech(null)} />}
        <div className="review-done-icon">🎉</div>
        <div className="review-done-title">{t("reviewSessionSummaryTitle")}</div>
        <div className="review-done-sub">
          {t("reviewSessionSummaryCards", { count: ratings.length })}
        </div>
        <div className="review-summary-grades">
          <span className="sum-again">{t("gradeAgain")}: {counts[0]}</span>
          <span className="sum-hard">{t("gradeHard")}: {counts[1]}</span>
          <span className="sum-good">{t("gradeGood")}: {counts[2]}</span>
          <span className="sum-easy">{t("gradeEasy")}: {counts[3]}</span>
        </div>
        <button className="test-start" onClick={onClose}>
          {t("reviewBackHome")}
        </button>
      </div>
    );
  }
  const card = queue[pos];
  return (
    <section className="review-session">
      <div className="review-progress">
        {t("reviewProgress", { current: pos + 1, total: queue.length })}
      </div>
      {leech && <LeechBanner card={leech} onClose={() => setLeech(null)} />}
      <ReviewFlipCard
        key={card.id}
        card={card}
        flipped={flipped}
        onFlip={() => setFlipped((f) => !f)}
        onGrade={(r, viaAi) => grade(card, r, viaAi)}
      />
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
          <li key={i} className={s.dead ? "source-dead" : undefined}>
            <a href={s.url} target="_blank" rel="noreferrer">
              {s.title || s.url}
            </a>
            <span className="sources-host">
              {hostnameOf(s.url)}
              {s.dead && ` · ${t("sourceDead")}`}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

// In-lesson retrieval prompt (mnemonic medium): bound to an FSRS card, so
// grading here reschedules the same card the review session uses.
function RecallWidget({
  id,
  widget,
  widgetCtx,
}: {
  id: string;
  widget: { card_id?: string; front: string; back: string };
  widgetCtx?: WidgetCtx;
}) {
  const t = useT();
  const [revealed, setRevealed] = useState(false);
  const [scheduledDays, setScheduledDays] = useState<number | null>(null);
  const cardState = widget.card_id ? widgetCtx?.recallCards?.[widget.card_id] : undefined;

  async function gradeIt(rating: 1 | 2 | 3 | 4) {
    if (!widget.card_id) {
      setScheduledDays(0);
      return;
    }
    try {
      const out = await invoke<GradeOutcome>("grade_card", {
        cardId: widget.card_id,
        rating,
        source: "inline",
      });
      setScheduledDays(out.card.scheduledDays ?? 0);
    } catch {
      setScheduledDays(0);
    }
  }

  return (
    <aside className="widget widget-recall" data-widget-id={id}>
      <div className="recall-label">✦ {t("recallLabel")}</div>
      <div className="recall-front">
        <MathMarkdown>{widget.front}</MathMarkdown>
      </div>
      {!revealed && scheduledDays === null && (
        <button className="recall-reveal" onClick={() => setRevealed(true)}>
          {t("recallReveal")}
        </button>
      )}
      {revealed && scheduledDays === null && (
        <>
          <div className="recall-back">
            <MathMarkdown>{widget.back}</MathMarkdown>
          </div>
          <GradeButtons preview={cardState?.preview} onGrade={gradeIt} />
        </>
      )}
      {scheduledDays !== null && (
        <div className="recall-scheduled">
          ✓ {t("recallScheduled", { interval: fmtInterval(scheduledDays, t) })}
        </div>
      )}
    </aside>
  );
}

// Formative checkpoint: a predict-then-reveal prompt embedded mid-article.
// ===== Template widgets: parameterized interactives rendered natively =====
// (replaces free-form LLM-written HTML; the param contract lives in
// sidecar/src/lib/widget-templates.mjs)

// Safe expression evaluator for the slider template — same grammar as the
// sidecar validator: numbers, declared vars, + - * / ^ (right-assoc pow,
// -x^2 == -(x^2)), parentheses, pi/e, whitelisted Math functions. Returns
// null on anything else; never throws, never eval()s.
const TPL_FN1: Record<string, (a: number) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  sqrt: Math.sqrt,
  abs: Math.abs,
  log: Math.log,
  exp: Math.exp,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
};
const TPL_FN2: Record<string, (a: number, b: number) => number> = {
  min: Math.min,
  max: Math.max,
  pow: Math.pow,
};
const TPL_CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E };

function tplEvalExpr(expr: string, scope: Record<string, number>): number | null {
  type Tok = { t: string; v?: number | string };
  const tokens: Tok[] = [];
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (/\s/.test(c)) i++;
    else if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < expr.length && /[0-9.]/.test(expr[j])) j++;
      const n = Number(expr.slice(i, j));
      if (!Number.isFinite(n)) return null;
      tokens.push({ t: "num", v: n });
      i = j;
    } else if (/[a-zA-Z_]/.test(c)) {
      let j = i;
      while (j < expr.length && /[a-zA-Z0-9_]/.test(expr[j])) j++;
      tokens.push({ t: "ident", v: expr.slice(i, j) });
      i = j;
    } else if ("+-*/^(),".includes(c)) {
      tokens.push({ t: c });
      i++;
    } else return null;
  }
  if (!tokens.length) return null;
  let pos = 0;
  let failed = false;
  const fail = () => {
    failed = true;
    return 0;
  };
  const eat = (t: string) => (tokens[pos]?.t === t ? tokens[pos++] : null);
  function level(): number {
    let v = term();
    for (;;) {
      if (eat("+")) v += term();
      else if (eat("-")) v -= term();
      else return v;
    }
  }
  function term(): number {
    let v = unary();
    for (;;) {
      if (eat("*")) v *= unary();
      else if (eat("/")) v /= unary();
      else return v;
    }
  }
  function unary(): number {
    if (eat("-")) return -unary();
    return power();
  }
  function power(): number {
    const base = atom();
    if (eat("^")) return Math.pow(base, unary());
    return base;
  }
  function atom(): number {
    const tok = tokens[pos];
    if (!tok) return fail();
    if (tok.t === "num") {
      pos++;
      return tok.v as number;
    }
    if (tok.t === "(") {
      pos++;
      const v = level();
      if (!eat(")")) return fail();
      return v;
    }
    if (tok.t === "ident") {
      pos++;
      const name = tok.v as string;
      if (eat("(")) {
        const args = [level()];
        while (eat(",")) args.push(level());
        if (!eat(")")) return fail();
        if (TPL_FN1[name] && args.length === 1) return TPL_FN1[name](args[0]);
        if (TPL_FN2[name] && args.length === 2) return TPL_FN2[name](args[0], args[1]);
        return fail();
      }
      if (Object.prototype.hasOwnProperty.call(scope, name)) return scope[name];
      if (name in TPL_CONSTS) return TPL_CONSTS[name];
      return fail();
    }
    return fail();
  }
  const result = level();
  if (failed || pos !== tokens.length || Number.isNaN(result)) return null;
  return result;
}

function TplMd({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex, [rehypeHighlight, { detect: true, ignoreMissing: true }]]}
    >
      {children}
    </ReactMarkdown>
  );
}

function TplFrame({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title?: string;
  description?: string;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <figure className="widget widget-template">
      <div className="widget-interactive-header">
        <span>{t("widgetInteractive")}</span>
        {title && <span className="widget-interactive-title">{title}</span>}
        <span className="widget-id">#{id}</span>
      </div>
      <div className="tpl-body">{children}</div>
      {description && (
        <figcaption className="widget-interactive-desc">{description}</figcaption>
      )}
    </figure>
  );
}

function TplScore({ correct, total }: { correct: number; total: number }) {
  const t = useT();
  return (
    <div className="tpl-score">{t("tplScore", { correct, total })}</div>
  );
}

function QuizTemplate({ params }: { params: any }) {
  const t = useT();
  const items: { question: string; options: string[]; correct: number; explanation?: string }[] =
    params.items ?? [];
  const [picked, setPicked] = useState<(number | null)[]>(() => items.map(() => null));
  const done = picked.every((p) => p !== null);
  const correctCount = items.reduce((n, it, i) => (picked[i] === it.correct ? n + 1 : n), 0);
  return (
    <>
      <ol className="tpl-quiz">
        {items.map((it, i) => (
          <li key={i} className="tpl-quiz-item">
            <div className="tpl-quiz-q reader">
              <TplMd>{it.question}</TplMd>
            </div>
            <div className="tpl-options">
              {it.options.map((opt, j) => {
                const chosen = picked[i] === j;
                let cls = "tpl-option";
                if (picked[i] !== null) {
                  if (j === it.correct) cls += " correct";
                  else if (chosen) cls += " wrong";
                }
                return (
                  <button
                    key={j}
                    className={cls}
                    disabled={picked[i] !== null}
                    onClick={() =>
                      setPicked((prev) => prev.map((p, k) => (k === i ? j : p)))
                    }
                  >
                    {opt}
                  </button>
                );
              })}
            </div>
            {picked[i] !== null && it.explanation && (
              <div className="tpl-explanation reader">
                <TplMd>{it.explanation}</TplMd>
              </div>
            )}
          </li>
        ))}
      </ol>
      {done && (
        <div className="tpl-footer">
          <TplScore correct={correctCount} total={items.length} />
          <button
            className="tpl-reset"
            onClick={() => setPicked(items.map(() => null))}
          >
            {t("tplReset")}
          </button>
        </div>
      )}
    </>
  );
}

function StepsTemplate({ params }: { params: any }) {
  const t = useT();
  const steps: { title?: string; text: string; code?: string; codeLang?: string }[] =
    params.steps ?? [];
  const [idx, setIdx] = useState(0);
  const step = steps[Math.min(idx, steps.length - 1)];
  if (!step) return null;
  return (
    <>
      <div className="tpl-step-head">
        <span className="tpl-step-count">{t("tplStep", { current: idx + 1, total: steps.length })}</span>
        {step.title && <span className="tpl-step-title">{step.title}</span>}
      </div>
      <div className="tpl-step-text reader">
        <TplMd>{step.text}</TplMd>
      </div>
      {step.code && (
        <pre className="tpl-step-code">
          <code className={step.codeLang ? `language-${step.codeLang}` : undefined}>
            {step.code}
          </code>
        </pre>
      )}
      <div className="tpl-nav">
        <button disabled={idx === 0} onClick={() => setIdx((i) => i - 1)}>
          ← {t("tplPrev")}
        </button>
        <button disabled={idx >= steps.length - 1} onClick={() => setIdx((i) => i + 1)}>
          {t("tplNext")} →
        </button>
      </div>
    </>
  );
}

function MatchTemplate({ params }: { params: any }) {
  const t = useT();
  const pairs: { left: string; right: string }[] = params.pairs ?? [];
  const rights = useMemo(() => shuffledCopy(pairs.map((p, i) => ({ text: p.right, idx: i }))), [pairs]);
  const [selLeft, setSelLeft] = useState<number | null>(null);
  const [matched, setMatched] = useState<Set<number>>(() => new Set());
  const [wrong, setWrong] = useState<number | null>(null);

  function pickRight(pairIdx: number) {
    if (selLeft === null || matched.has(pairIdx)) return;
    if (pairIdx === selLeft) {
      setMatched((prev) => new Set(prev).add(pairIdx));
      setSelLeft(null);
    } else {
      setWrong(pairIdx);
      setTimeout(() => setWrong(null), 500);
    }
  }

  const allDone = matched.size === pairs.length;
  return (
    <>
      {params.prompt && <div className="tpl-prompt">{params.prompt}</div>}
      <div className="tpl-match-cols">
        <div className="tpl-match-col">
          {pairs.map((p, i) => (
            <button
              key={i}
              className={`tpl-chip${selLeft === i ? " selected" : ""}${matched.has(i) ? " matched" : ""}`}
              disabled={matched.has(i)}
              onClick={() => setSelLeft(i)}
            >
              {p.left}
            </button>
          ))}
        </div>
        <div className="tpl-match-col">
          {rights.map((r) => (
            <button
              key={r.idx}
              className={`tpl-chip${matched.has(r.idx) ? " matched" : ""}${wrong === r.idx ? " wrong" : ""}`}
              disabled={matched.has(r.idx)}
              onClick={() => pickRight(r.idx)}
            >
              {r.text}
            </button>
          ))}
        </div>
      </div>
      {allDone && (
        <div className="tpl-footer">
          <TplScore correct={pairs.length} total={pairs.length} />
          <button className="tpl-reset" onClick={() => setMatched(new Set())}>
            {t("tplReset")}
          </button>
        </div>
      )}
    </>
  );
}

function FillBlankTemplate({ params }: { params: any }) {
  const t = useT();
  const items: { text: string; answers: string[]; hint?: string }[] = params.items ?? [];
  const [values, setValues] = useState<string[]>(() => items.map(() => ""));
  const [checked, setChecked] = useState(false);
  const [hintShown, setHintShown] = useState<Set<number>>(() => new Set());
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const isCorrect = (i: number) => items[i].answers.some((a) => norm(a) === norm(values[i]));
  const correctCount = items.reduce((n, _, i) => (isCorrect(i) ? n + 1 : n), 0);
  return (
    <>
      <ol className="tpl-fillblank">
        {items.map((it, i) => {
          const [before, after] = it.text.split("___");
          return (
            <li key={i} className="tpl-fb-item">
              <span className="tpl-fb-text">
                {before}
                <input
                  className={`tpl-fb-input${checked ? (isCorrect(i) ? " correct" : " wrong") : ""}`}
                  value={values[i]}
                  disabled={checked}
                  onChange={(e) =>
                    setValues((prev) => prev.map((v, k) => (k === i ? e.target.value : v)))
                  }
                />
                {after}
              </span>
              {it.hint && !checked && (
                <button
                  className="tpl-hint-btn"
                  onClick={() => setHintShown((prev) => new Set(prev).add(i))}
                >
                  {hintShown.has(i) ? it.hint : t("tplShowHint")}
                </button>
              )}
              {checked && !isCorrect(i) && (
                <span className="tpl-fb-answer">→ {it.answers[0]}</span>
              )}
            </li>
          );
        })}
      </ol>
      <div className="tpl-footer">
        {!checked ? (
          <button
            className="tpl-check"
            disabled={values.some((v) => !v.trim())}
            onClick={() => setChecked(true)}
          >
            {t("tplCheck")}
          </button>
        ) : (
          <>
            <TplScore correct={correctCount} total={items.length} />
            <button
              className="tpl-reset"
              onClick={() => {
                setChecked(false);
                setValues(items.map(() => ""));
              }}
            >
              {t("tplReset")}
            </button>
          </>
        )}
      </div>
    </>
  );
}

function OrderTemplate({ params }: { params: any }) {
  const t = useT();
  const correct: string[] = params.items ?? [];
  const initial = useMemo(() => {
    let s = shuffledCopy(correct);
    // A shuffle that lands on the correct order teaches nothing — reshuffle once.
    if (s.join("") === correct.join("")) s = shuffledCopy(correct);
    return s;
  }, [correct]);
  const [items, setItems] = useState<string[]>(initial);
  const [checked, setChecked] = useState(false);
  const move = (i: number, d: number) => {
    setItems((prev) => {
      const next = [...prev];
      const j = i + d;
      if (j < 0 || j >= next.length) return prev;
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };
  const correctCount = items.reduce((n, it, i) => (it === correct[i] ? n + 1 : n), 0);
  return (
    <>
      {params.prompt && <div className="tpl-prompt">{params.prompt}</div>}
      <ol className="tpl-order">
        {items.map((it, i) => (
          <li
            key={it}
            className={`tpl-order-item${checked ? (it === correct[i] ? " correct" : " wrong") : ""}`}
          >
            <span className="tpl-order-text">{it}</span>
            {!checked && (
              <span className="tpl-order-btns">
                <button disabled={i === 0} onClick={() => move(i, -1)} aria-label="up">
                  ↑
                </button>
                <button
                  disabled={i === items.length - 1}
                  onClick={() => move(i, 1)}
                  aria-label="down"
                >
                  ↓
                </button>
              </span>
            )}
          </li>
        ))}
      </ol>
      <div className="tpl-footer">
        {!checked ? (
          <button className="tpl-check" onClick={() => setChecked(true)}>
            {t("tplCheck")}
          </button>
        ) : (
          <>
            <TplScore correct={correctCount} total={items.length} />
            <button
              className="tpl-reset"
              onClick={() => {
                setChecked(false);
                setItems(shuffledCopy(correct));
              }}
            >
              {t("tplReset")}
            </button>
          </>
        )}
      </div>
    </>
  );
}

function SliderTemplate({ params }: { params: any }) {
  const vars: { name: string; label: string; min: number; max: number; step: number; init: number }[] =
    params.vars ?? [];
  const outputs: {
    label: string;
    expr: string;
    format?: string;
    suffix?: string;
    bar?: { min: number; max: number };
  }[] = params.outputs ?? [];
  const [values, setValues] = useState<Record<string, number>>(() =>
    Object.fromEntries(vars.map((v) => [v.name, v.init]))
  );
  const fmt = (n: number, format?: string) => {
    if (!Number.isFinite(n)) return "—";
    if (format === "int") return String(Math.round(n));
    if (format === "fixed1") return n.toFixed(1);
    if (format === "fixed2") return n.toFixed(2);
    const abs = Math.abs(n);
    if (abs !== 0 && (abs >= 100000 || abs < 0.01)) return n.toExponential(2);
    return String(Math.round(n * 100) / 100);
  };
  return (
    <>
      {params.note && <div className="tpl-prompt">{params.note}</div>}
      {vars.map((v) => (
        <label key={v.name} className="tpl-slider-row">
          <span className="tpl-slider-label">{v.label}</span>
          <input
            type="range"
            min={v.min}
            max={v.max}
            step={v.step}
            value={values[v.name]}
            onChange={(e) =>
              setValues((prev) => ({ ...prev, [v.name]: Number(e.target.value) }))
            }
          />
          <span className="tpl-slider-value">{fmt(values[v.name])}</span>
        </label>
      ))}
      <div className="tpl-outputs">
        {outputs.map((o, i) => {
          const val = tplEvalExpr(o.expr, values);
          const display = val === null ? "—" : fmt(val, o.format);
          const pct =
            o.bar && val !== null && Number.isFinite(val)
              ? Math.max(0, Math.min(100, ((val - o.bar.min) / (o.bar.max - o.bar.min)) * 100))
              : null;
          return (
            <div key={i} className="tpl-output">
              <span className="tpl-output-label">{o.label}</span>
              <span className="tpl-output-value">
                {display}
                {o.suffix ? ` ${o.suffix}` : ""}
              </span>
              {pct !== null && (
                <span className="tpl-bar">
                  <span className="tpl-bar-fill" style={{ width: `${pct}%` }} />
                </span>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

function CategorizeTemplate({ params }: { params: any }) {
  const t = useT();
  const buckets: string[] = params.buckets ?? [];
  const items: { text: string; bucket: number }[] = params.items ?? [];
  const order = useMemo(() => shuffledCopy(items.map((_, i) => i)), [items]);
  // assignment[itemIdx] = bucketIdx | null
  const [assigned, setAssigned] = useState<(number | null)[]>(() => items.map(() => null));
  const [active, setActive] = useState<number | null>(null);
  const [checked, setChecked] = useState(false);
  const pool = order.filter((i) => assigned[i] === null);
  const correctCount = items.reduce((n, it, i) => (assigned[i] === it.bucket ? n + 1 : n), 0);
  const assign = (bucketIdx: number) => {
    if (active === null || checked) return;
    setAssigned((prev) => prev.map((b, i) => (i === active ? bucketIdx : b)));
    setActive(null);
  };
  return (
    <>
      {params.prompt && <div className="tpl-prompt">{params.prompt}</div>}
      {pool.length > 0 && (
        <div className="tpl-cat-pool">
          {pool.map((i) => (
            <button
              key={i}
              className={`tpl-chip${active === i ? " selected" : ""}`}
              onClick={() => setActive(i)}
            >
              {items[i].text}
            </button>
          ))}
        </div>
      )}
      <div className="tpl-cat-buckets">
        {buckets.map((b, bi) => (
          <div
            key={bi}
            className={`tpl-cat-bucket${active !== null ? " droppable" : ""}`}
            onClick={() => assign(bi)}
          >
            <div className="tpl-cat-bucket-title">{b}</div>
            <div className="tpl-cat-bucket-items">
              {items.map((it, i) =>
                assigned[i] === bi ? (
                  <button
                    key={i}
                    className={`tpl-chip${checked ? (it.bucket === bi ? " correct" : " wrong") : ""}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!checked)
                        setAssigned((prev) => prev.map((x, k) => (k === i ? null : x)));
                    }}
                  >
                    {it.text}
                  </button>
                ) : null
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="tpl-footer">
        {!checked ? (
          <button
            className="tpl-check"
            disabled={pool.length > 0}
            onClick={() => setChecked(true)}
          >
            {t("tplCheck")}
          </button>
        ) : (
          <>
            <TplScore correct={correctCount} total={items.length} />
            <button
              className="tpl-reset"
              onClick={() => {
                setChecked(false);
                setAssigned(items.map(() => null));
              }}
            >
              {t("tplReset")}
            </button>
          </>
        )}
      </div>
    </>
  );
}

function FlipcardsTemplate({ params }: { params: any }) {
  const t = useT();
  const cards: { front: string; back: string }[] = params.cards ?? [];
  const [idx, setIdx] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const card = cards[Math.min(idx, cards.length - 1)];
  if (!card) return null;
  const go = (d: number) => {
    setIdx((i) => Math.min(cards.length - 1, Math.max(0, i + d)));
    setFlipped(false);
  };
  return (
    <>
      <button
        className={`flashcard tpl-flipcard${flipped ? " is-flipped" : ""}`}
        onClick={() => setFlipped((f) => !f)}
      >
        <div className="flashcard-face reader">
          <TplMd>{flipped ? card.back : card.front}</TplMd>
        </div>
        <div className="flashcard-hint">{t("tplFlip")}</div>
      </button>
      <div className="tpl-nav">
        <button disabled={idx === 0} onClick={() => go(-1)}>
          ← {t("tplPrev")}
        </button>
        <span className="tpl-step-count">
          {idx + 1} / {cards.length}
        </span>
        <button disabled={idx >= cards.length - 1} onClick={() => go(1)}>
          {t("tplNext")} →
        </button>
      </div>
    </>
  );
}

const TEMPLATE_COMPONENTS: Record<string, (p: { params: any }) => ReactNode> = {
  quiz: QuizTemplate,
  steps: StepsTemplate,
  match: MatchTemplate,
  fillblank: FillBlankTemplate,
  order: OrderTemplate,
  slider: SliderTemplate,
  categorize: CategorizeTemplate,
  flipcards: FlipcardsTemplate,
};

function TemplateWidget({
  id,
  widget,
}: {
  id: string;
  widget: { template?: string; params?: any; title?: string; description?: string };
}) {
  const t = useT();
  const Component = widget.template ? TEMPLATE_COMPONENTS[widget.template] : undefined;
  if (!Component || !widget.params) {
    return (
      <div className="widget widget-unknown">
        {t("widgetUnknown")}: {widget.template} <span className="widget-id">#{id}</span>
      </div>
    );
  }
  return (
    <TplFrame id={id} title={widget.title} description={widget.description}>
      <Component params={widget.params} />
    </TplFrame>
  );
}

// Minimal params editor for template widgets in the LessonEditor: a JSON
// textarea with validate-on-apply (deep validation lives in the sidecar
// normalizer; here we only guard against unparseable JSON).
function TplParamsEditor({
  params,
  disabled,
  onApply,
}: {
  params: any;
  disabled?: boolean;
  onApply: (params: any) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState(() => JSON.stringify(params ?? {}, null, 2));
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="tpl-params-editor">
      <textarea
        className="le-code"
        value={draft}
        disabled={disabled}
        onChange={(e) => {
          setDraft(e.target.value);
          setError(null);
        }}
      />
      <button
        className="ghost le-toggle"
        disabled={disabled}
        onClick={() => {
          try {
            const parsed = JSON.parse(draft);
            if (!parsed || typeof parsed !== "object") throw new Error("not an object");
            onApply(parsed);
          } catch {
            setError(t("tplJsonError"));
          }
        }}
      >
        {t("tplApply")}
      </button>
      {error && <span className="le-error">{error}</span>}
    </div>
  );
}

function CheckpointWidget({
  id,
  widget,
}: {
  id: string;
  widget: { question: string; answer: string };
}) {
  const t = useT();
  const [revealed, setRevealed] = useState(false);
  const md = (text: string) => (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex, [rehypeHighlight, { detect: true, ignoreMissing: true }]]}
    >
      {text}
    </ReactMarkdown>
  );
  return (
    <figure className="widget widget-checkpoint">
      <div className="widget-checkpoint-label">
        ✦ {t("checkpointLabel")} <span className="widget-id">#{id}</span>
      </div>
      <div className="widget-checkpoint-q reader">{md(widget.question)}</div>
      {revealed ? (
        <div className="widget-checkpoint-a reader">{md(widget.answer)}</div>
      ) : (
        <button className="widget-checkpoint-reveal" onClick={() => setRevealed(true)}>
          {t("checkpointReveal")}
        </button>
      )}
    </figure>
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
  editImages,
}: {
  id: string;
  widget: { caption?: string; items?: WidgetImageItem[] };
  onOpenImage?: (key: string) => void;
  editImages?: boolean;
}) {
  const t = useT();
  const items = Array.isArray(widget.items) ? widget.items : [];
  const [failed, setFailed] = useState<Set<number>>(new Set());

  useEffect(() => {
    setFailed(new Set());
  }, [widget.items]);

  const isUnresolved = (item: WidgetImageItem) =>
    item.placeholder === true || !resolveWidgetImage(item.url, item.source).imgSrc;

  // Read mode: hide the whole gallery when nothing resolved (and skip unresolved
  // items below, preserving original indices for the lightbox).
  if (!editImages && (items.length === 0 || items.every(isUnresolved))) return null;

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
          if (!editImages && (isUnresolved(item) || failed.has(index))) return null;
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

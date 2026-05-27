import {
  createContext,
  ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export type Lang = "ru" | "en";

const STRINGS = {
  ru: {
    brand: "Learn Anything",
    newCourse: "+ Новый курс",
    noCourses: "Курсов пока нет",
    generatingTitle: "Идёт генерация…",
    settings: "Настройки",

    selectOrCreate: "Выберите курс или создайте новый",

    createTitle: "Новый курс",
    topicLabel: "Тема",
    topicPlaceholder: "например: академическая живопись",
    agentLabel: "Агент",
    claudeDesc: "Anthropic, подписка Pro/Max",
    codexDesc: "OpenAI, ChatGPT-подписка, веб-поиск",
    create: "Создать",
    cancel: "Отмена",

    courseNotFound: "Курс не найден",
    statusWizard: "визард",
    statusStructuring: "ждёт структуру",
    statusReady: "готов",

    wizardIntro:
      "Прежде чем строить программу, агент задаст несколько уточняющих вопросов с вариантами ответов. Это займёт ~10-30 секунд — можно открыть другой курс или вернуться позже, UI не блокируется.",
    startWizard: "Начать визард",
    wizardThinking: "Подумаю над вопросами…",
    errorPrefix: "Ошибка: {error}",
    retry: "Попробовать снова",
    noQuestionsReturned: "Агент не вернул вопросов.",

    answeringIntro: "Отмечай подходящие варианты, можно несколько. Свой ответ — в поле ниже. Пустые вопросы пропускаем.",
    customAnswerPlaceholder: "Свой ответ (можно дополнить выбранное)…",
    optMulti: "несколько вариантов",
    optSingle: "один вариант",
    saving: "Сохраняю…",
    saveAnswers: "Сохранить ответы",

    builderIntro:
      "Ответы визарда сохранены. Агент исследует тему и предложит структуру курса. Это займёт 30 секунд — 2 минуты. UI не блокируется — можно переключить курс.",
    buildingStructure: "Строю структуру…",
    generateStructure: "Сгенерировать структуру",

    loadError: "Ошибка загрузки: {error}",
    loadingStructure: "Загружаю структуру…",
    emptyStructure: "Структура пустая.",
    generateNextSub: "Сгенерировать следующий сабмодуль",
    generatingFirst: "Запускаю генерацию…",
    allSubsDone: "Все сабмодули сгенерированы",
    refinePlanButton: "Доработать план",
    closeRefine: "Свернуть",
    deleteCourse: "Удалить курс",
    deleteCourseTitle: "Удалить курс «{topic}»?",
    deleteCourseWarning:
      "Будут удалены все сгенерированные статьи, виджеты, история визарда и память правок. Это действие нельзя отменить.",
    deleteConfirm: "Удалить",
    deleting: "Удаляю…",
    subGenerate: "Сгенерировать",
    subOpen: "Открыть",
    subRetry: "Повторить",
    backToCourse: "← К курсу",
    stageDraft: "Черновик",
    stageReview: "Редактура",
    stageAnnotate: "Валидация",
    stageIllustrate: "Иллюстрации",
    stagePendingHint: "Сабмодуль ещё не сгенерирован.",
    stageFailedHint: "Прошлая генерация не удалась. Можно попробовать снова.",
    stageRunning: "Идёт генерация…",
    actThinking: "обдумывает",
    actWriting: "пишет",
    actSearching: "ищет",
    actReviewing: "редактирует",
    actMarking: "размечает иллюстрации",
    actValidating: "проверяет диаграммы",
    actDownloading: "скачивает картинку",
    actRunning: "выполняет",
    widgetImage: "Картинка-заглушка",
    widgetImageAlt: "alt:",
    widgetDiagramError: "Ошибка диаграммы",
    widgetUnknown: "Неизвестный виджет",
    widgetVideoRecommended: "Рекомендация:",
    widgetVideoOpen: "Открыть видео",
    sourcesTitle: "Источники",

    refineTitle: "Доработать с агентом",
    refineSub:
      "Опиши, что переделать — агент предложит новую структуру с пояснением. Принятые правки сохраняются в памяти курса и учитываются дальше.",
    chatEmpty: "Пока пусто. Начни обсуждение.",
    refineInputPlaceholder:
      "Напиши, что переделать. Например: «добавь модуль про композицию, сделай больше упор на масляную живопись»",
    refineInputPlaceholderShort: "Сообщение агенту…",
    proposal: "Предложение",
    accept: "Принять",
    applying: "Применяю…",
    proposalHint: "Не подходит? Опиши, что переделать, в поле ниже.",
    agentThinking: "Агент думает…",
    kbdHint: "⌘/Ctrl + Enter — отправить",
    send: "Отправить",

    settingsTitle: "Настройки",
    uiLanguage: "Язык интерфейса",
    uiLanguageNote: "Сам контент курсов остаётся на своём языке.",
    langRu: "Русский",
    langEn: "English",
    close: "Закрыть",
    braveTitle: "Brave Search",
    braveNote:
      "Подписочный ключ Brave Search API. Подключает MCP-сервер к агенту — он сможет искать информацию и картинки во время генерации сабмодуля. Ключ хранится локально в settings.json и не уходит в sidecar напрямую.",
    bravePlaceholder: "BSA…",
    braveConfigured: "Ключ сохранён",
    braveSave: "Сохранить",
    braveClear: "Очистить",
  },
  en: {
    brand: "Learn Anything",
    newCourse: "+ New course",
    noCourses: "No courses yet",
    generatingTitle: "Generation in progress…",
    settings: "Settings",

    selectOrCreate: "Select a course or create a new one",

    createTitle: "New course",
    topicLabel: "Topic",
    topicPlaceholder: "e.g. academic painting",
    agentLabel: "Agent",
    claudeDesc: "Anthropic, Pro/Max subscription",
    codexDesc: "OpenAI, ChatGPT subscription, web search",
    create: "Create",
    cancel: "Cancel",

    courseNotFound: "Course not found",
    statusWizard: "wizard",
    statusStructuring: "structuring",
    statusReady: "ready",

    wizardIntro:
      "Before building the program, the agent will ask a few clarifying questions with answer options. Takes ~10–30 seconds — you can switch to another course or come back later, the UI stays interactive.",
    startWizard: "Start wizard",
    wizardThinking: "Thinking about the questions…",
    errorPrefix: "Error: {error}",
    retry: "Try again",
    noQuestionsReturned: "Agent returned no questions.",

    answeringIntro: "Tick the ones that apply, you can pick several. Add your own answer below. Empty questions are skipped.",
    customAnswerPlaceholder: "Your answer (can complement what's selected)…",
    optMulti: "several",
    optSingle: "pick one",
    saving: "Saving…",
    saveAnswers: "Save answers",

    builderIntro:
      "Wizard answers saved. The agent will research the topic and propose a course structure. Takes 30 seconds – 2 minutes. UI stays interactive — you can switch courses.",
    buildingStructure: "Building structure…",
    generateStructure: "Generate structure",

    loadError: "Load error: {error}",
    loadingStructure: "Loading structure…",
    emptyStructure: "Structure is empty.",
    generateNextSub: "Generate next submodule",
    generatingFirst: "Starting generation…",
    allSubsDone: "All submodules generated",
    refinePlanButton: "Refine plan",
    closeRefine: "Collapse",
    deleteCourse: "Delete course",
    deleteCourseTitle: "Delete course \"{topic}\"?",
    deleteCourseWarning:
      "All generated articles, widgets, wizard history and refinement memory will be removed. This cannot be undone.",
    deleteConfirm: "Delete",
    deleting: "Deleting…",
    subGenerate: "Generate",
    subOpen: "Open",
    subRetry: "Retry",
    backToCourse: "← Back to course",
    stageDraft: "Draft",
    stageReview: "Review",
    stageAnnotate: "Validation",
    stageIllustrate: "Illustrations",
    stagePendingHint: "This submodule has not been generated yet.",
    stageFailedHint: "Previous generation failed. You can try again.",
    stageRunning: "Generation in progress…",
    actThinking: "thinking",
    actWriting: "writing",
    actSearching: "searching",
    actReviewing: "reviewing",
    actMarking: "marking up images",
    actValidating: "validating diagrams",
    actDownloading: "downloading image",
    actRunning: "running",
    widgetImage: "Image placeholder",
    widgetImageAlt: "alt:",
    widgetDiagramError: "Diagram error",
    widgetUnknown: "Unknown widget",
    widgetVideoRecommended: "Recommended by:",
    widgetVideoOpen: "Open video",
    sourcesTitle: "Sources",

    refineTitle: "Refine with agent",
    refineSub:
      "Describe what to change — the agent will propose a new structure with rationale. Accepted edits are saved to course memory and respected later.",
    chatEmpty: "Empty so far. Start the conversation.",
    refineInputPlaceholder:
      'Describe what to change. E.g.: "add a module on composition, lean more into oil painting"',
    refineInputPlaceholderShort: "Message to the agent…",
    proposal: "Proposal",
    accept: "Accept",
    applying: "Applying…",
    proposalHint: "Doesn't fit? Describe what to change in the field below.",
    agentThinking: "Agent is thinking…",
    kbdHint: "⌘/Ctrl + Enter to send",
    send: "Send",

    settingsTitle: "Settings",
    uiLanguage: "Interface language",
    uiLanguageNote: "Course content itself stays in its own language.",
    langRu: "Русский",
    langEn: "English",
    close: "Close",
    braveTitle: "Brave Search",
    braveNote:
      "Brave Search API subscription key. Connects the MCP server to the agent so it can search the web and images while generating a submodule. Stored locally in settings.json; never passed to the sidecar directly.",
    bravePlaceholder: "BSA…",
    braveConfigured: "Key saved",
    braveSave: "Save",
    braveClear: "Clear",
  },
} as const;

type Key = keyof typeof STRINGS.ru;
type Vars = Record<string, string | number>;

function interp(s: string, vars?: Vars): string {
  if (!vars) return s;
  let out = s;
  for (const k in vars) out = out.split(`{${k}}`).join(String(vars[k]));
  return out;
}

const I18nContext = createContext<{
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: Key, vars?: Vars) => string;
} | null>(null);

const STORAGE_KEY = "learnAnything.uiLang";

function detect(): Lang {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "ru" || stored === "en") return stored;
  return navigator.language?.toLowerCase().startsWith("ru") ? "ru" : "en";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(detect);
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, lang);
    document.documentElement.lang = lang;
  }, [lang]);
  const value = useMemo(
    () => ({
      lang,
      setLang,
      t: (key: Key, vars?: Vars) =>
        interp((STRINGS[lang][key] as string | undefined) ?? STRINGS.ru[key] ?? key, vars),
    }),
    [lang]
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

function useCtx() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useT/useLang must be used inside <I18nProvider>");
  return ctx;
}

export function useT() {
  return useCtx().t;
}

export function useLang() {
  const ctx = useCtx();
  return [ctx.lang, ctx.setLang] as const;
}

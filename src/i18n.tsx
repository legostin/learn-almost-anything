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
    brand: "Learn (Almost) Anything",
    newCourse: "+ Новый курс",
    noCourses: "Курсов пока нет",
    generatingTitle: "Идёт генерация…",
    settings: "Настройки",

    selectOrCreate: "Выберите курс или создайте новый",
    noAgentsTitle: "Нет ни одного агента",
    noAgentsBody:
      "Чтобы генерировать курсы, нужен хотя бы один локально установленный CLI и логин: claude (Pro/Max) или codex (ChatGPT Plus/Pro). Установи и залогинься — тогда вернись сюда.",
    agentUnavailable: "не установлен",
    agentAvailable: "доступен",
    braveMissingWarning:
      "Brave Search не настроен. Агент будет генерировать только по своей памяти — без актуальных источников, картинок и видео. Открой настройки и добавь ключ.",
    openSettings: "Открыть настройки",

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
    subContinue: "Продолжить",
    subRegenerate: "Перегенерировать",
    subRegenerateConfirm: "Перегенерировать модуль? Текущая версия (статья, виджеты и тест) будет заменена.",
    backToCourse: "← К курсу",
    stageDraft: "Черновик",
    stageReview: "Редактура",
    stageAnnotate: "Валидация",
    stageIllustrate: "Иллюстрации",
    stageTest: "Тест",
    stagePendingHint: "Сабмодуль ещё не сгенерирован.",
    subEnriching: "Иллюстрации и тест догружаются…",
    lectureListen: "Слушать",
    lecturePause: "Пауза",
    lectureResume: "Продолжить",
    lectureStop: "Стоп",
    ttsTitle: "Озвучка лекций",
    ttsSystem: "Системный голос (бесплатно)",
    ttsGemini: "Gemini (платно)",
    ttsNote:
      "Системный голос — встроенный в приложение, бесплатный. Gemini — облачный синтез речи: качество выше, но каждый запрос тарифицируется по вашему ключу Gemini API.",
    ttsGeminiNeedsKey: "Gemini доступен только после добавления ключа Gemini API (выше).",
    ttsVoiceLabel: "Голос:",
    ttsModelLabel: "Модель TTS:",
    geminiImageModelLabel: "Модель для изображений:",
    lecturePreparing: "Готовлю аудио…",
    audioExpand: "Развернуть плеер",
    audioCollapse: "Свернуть плеер",
    audioChunk: "Фрагмент",
    audioBack10: "−10 секунд",
    audioFwd10: "+10 секунд",
    assignmentsTitle: "Домашние задания",
    assignmentsGenerate: "Сгенерировать домашнее задание",
    assignmentsGenerating: "Генерирую задания…",
    assignmentCriteria: "Критерии оценки",
    assignmentLocked: "Сначала выполните предыдущее задание.",
    assignmentAnswerPlaceholder: "Ваш ответ…",
    assignmentNotePlaceholder: "Комментарий к работе (необязательно)…",
    assignmentSend: "Отправить на проверку",
    assignmentReviewing: "Агент проверяет…",
    assignmentPassed: "Задание зачтено ✓",
    assignmentYou: "Вы",
    assignmentReviewer: "Проверяющий",
    assignmentVerdictPassed: "зачтено",
    assignmentVerdictRevise: "на доработку",
    assignmentNeedText: "Введите ответ.",
    assignmentNeedUrl: "Вставьте ссылку на репозиторий.",
    assignmentNeedFile: "Прикрепите файл.",
    assignmentTooBig: "Файл больше {mb} МБ.",
    critCritical: "критично",
    critMajor: "важно",
    critMinor: "мелочь",
    stageFailedHint: "Прошлая генерация не удалась. Можно попробовать снова.",
    stageRunning: "Идёт генерация…",
    actThinking: "обдумывает",
    actWriting: "пишет",
    actSearching: "ищет",
    actReading: "читает источник",
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
    widgetInteractive: "Интерактив",
    widgetInteractiveBroken: "Виджет не прошёл проверку",
    widgetInteractiveShowSource: "Показать исходник",
    testTitle: "Проверь себя",
    testStart: "Пройти тест",
    testSubmit: "Проверить ответы",
    testRetake: "Пройти заново",
    testScore: "Результат: {correct} из {total}",
    testPassed: "Тест пройден — блок изучен",
    testFailed: "Нужно {threshold}% — попробуй ещё раз",
    testYourAnswer: "Твой ответ",
    testCorrectAnswer: "Правильный ответ",
    subLearned: "Изучено",

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
    geminiTitle: "Gemini (генерация картинок)",
    geminiPlaceholder: "AIza…",
    geminiConfigured: "Ключ сохранён",
    geminiNote:
      "API-ключ Google Gemini для генерации иллюстраций (Nano Banana, gemini-2.5-flash-image). Агент сам решает: реальную вещь (например, картину да Винчи) — искать, а сложную кастомную иллюстрацию — генерировать. Без ключа всё идёт через поиск.",
    imgGenerated: "Сгенерировано ИИ",
    switchProvider: "Сменить провайдера (Claude/Codex)",
    crumbCourses: "Курсы",
    fontSize: "Размер шрифта",
    diagramZoom: "Нажми, чтобы увеличить",
    shareTitle: "Доступ с планшета",
    shareStart: "Открыть доступ",
    shareStarting: "Запуск ngrok…",
    shareStop: "Закрыть доступ",
    shareCopy: "Скопировать ссылку",
    shareDomainAuto: "Случайный URL",
    shareAddDomain: "ваш-домен.ngrok.app",
    shareAdd: "Добавить",
    shareRemove: "Удалить домен",
    modelsTitle: "Модели по задачам",
    modelsCatPlanning: "Планирование",
    modelsCatWriting: "Написание модулей",
    modelsCatTests: "Тесты",
    modelsDefault: "По умолчанию",
    modelsReasoningDefault: "Размышления: по умолч.",
    modelsLoading: "Загрузка…",
    modelsNote:
      "Модель и уровень размышлений для каждого вида задач, отдельно для Claude и Codex. Пусто = модель агента по умолчанию. Низкий уровень размышлений ускоряет, высокий — повышает качество.",
    shareNote:
      "Запускает ngrok-туннель к локальному серверу. Откройте ссылку на планшете, чтобы создавать и проходить курсы. При первом заходе ngrok покажет страницу-предупреждение — нажмите «Visit Site». Доступ открыт, пока приложение запущено.",
  },
  en: {
    brand: "Learn (Almost) Anything",
    newCourse: "+ New course",
    noCourses: "No courses yet",
    generatingTitle: "Generation in progress…",
    settings: "Settings",

    selectOrCreate: "Select a course or create a new one",
    noAgentsTitle: "No agent installed",
    noAgentsBody:
      "Generating courses requires at least one locally installed and logged-in CLI: claude (Pro/Max) or codex (ChatGPT Plus/Pro). Install and log in, then come back.",
    agentUnavailable: "not installed",
    agentAvailable: "available",
    braveMissingWarning:
      "Brave Search is not configured. The agent will write only from its own memory — no live sources, images or videos. Open settings to add a key.",
    openSettings: "Open settings",

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
    subContinue: "Continue",
    subRegenerate: "Regenerate",
    subRegenerateConfirm: "Regenerate this module? The current version (article, widgets and test) will be replaced.",
    backToCourse: "← Back to course",
    stageDraft: "Draft",
    stageReview: "Review",
    stageAnnotate: "Validation",
    stageIllustrate: "Illustrations",
    stageTest: "Test",
    stagePendingHint: "This submodule has not been generated yet.",
    subEnriching: "Illustrations and test are loading…",
    lectureListen: "Listen",
    lecturePause: "Pause",
    lectureResume: "Resume",
    lectureStop: "Stop",
    ttsTitle: "Lecture audio",
    ttsSystem: "System voice (free)",
    ttsGemini: "Gemini (paid)",
    ttsNote:
      "System voice is built into the app and free. Gemini is cloud speech synthesis: higher quality, but every request is billed to your Gemini API key.",
    ttsGeminiNeedsKey: "Gemini is available only after you add a Gemini API key (above).",
    ttsVoiceLabel: "Voice:",
    ttsModelLabel: "TTS model:",
    geminiImageModelLabel: "Image model:",
    lecturePreparing: "Preparing audio…",
    audioExpand: "Expand player",
    audioCollapse: "Collapse player",
    audioChunk: "Chunk",
    audioBack10: "Back 10 seconds",
    audioFwd10: "Forward 10 seconds",
    assignmentsTitle: "Assignments",
    assignmentsGenerate: "Generate homework",
    assignmentsGenerating: "Generating assignments…",
    assignmentCriteria: "Grading criteria",
    assignmentLocked: "Complete the previous assignment first.",
    assignmentAnswerPlaceholder: "Your answer…",
    assignmentNotePlaceholder: "A note about your work (optional)…",
    assignmentSend: "Submit for review",
    assignmentReviewing: "Reviewing…",
    assignmentPassed: "Assignment passed ✓",
    assignmentYou: "You",
    assignmentReviewer: "Reviewer",
    assignmentVerdictPassed: "passed",
    assignmentVerdictRevise: "needs work",
    assignmentNeedText: "Enter your answer.",
    assignmentNeedUrl: "Paste a repository link.",
    assignmentNeedFile: "Attach a file.",
    assignmentTooBig: "File exceeds {mb} MB.",
    critCritical: "critical",
    critMajor: "major",
    critMinor: "minor",
    stageFailedHint: "Previous generation failed. You can try again.",
    stageRunning: "Generation in progress…",
    actThinking: "thinking",
    actWriting: "writing",
    actSearching: "searching",
    actReading: "reading source",
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
    widgetInteractive: "Interactive",
    widgetInteractiveBroken: "Widget failed validation",
    widgetInteractiveShowSource: "Show source",
    testTitle: "Check yourself",
    testStart: "Take the test",
    testSubmit: "Check answers",
    testRetake: "Retake",
    testScore: "Score: {correct} of {total}",
    testPassed: "Passed — block marked learned",
    testFailed: "Need {threshold}% — try again",
    testYourAnswer: "Your answer",
    testCorrectAnswer: "Correct answer",
    subLearned: "Learned",

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
    geminiTitle: "Gemini (image generation)",
    geminiPlaceholder: "AIza…",
    geminiConfigured: "Key saved",
    geminiNote:
      "Google Gemini API key for generating illustrations (Nano Banana, gemini-2.5-flash-image). The agent decides per image: search a real thing (e.g. a da Vinci painting), generate a complex custom illustration. Without a key everything goes through search.",
    imgGenerated: "AI-generated",
    switchProvider: "Switch provider (Claude/Codex)",
    crumbCourses: "Courses",
    fontSize: "Font size",
    diagramZoom: "Tap to zoom",
    shareTitle: "Access from tablet",
    shareStart: "Start sharing",
    shareStarting: "Starting ngrok…",
    shareStop: "Stop sharing",
    shareCopy: "Copy link",
    shareDomainAuto: "Random URL",
    shareAddDomain: "your-domain.ngrok.app",
    shareAdd: "Add",
    shareRemove: "Remove domain",
    modelsTitle: "Models per task",
    modelsCatPlanning: "Planning",
    modelsCatWriting: "Writing modules",
    modelsCatTests: "Tests",
    modelsDefault: "Default",
    modelsReasoningDefault: "Reasoning: default",
    modelsLoading: "Loading…",
    modelsNote:
      "Model and reasoning level for each kind of task, separately for Claude and Codex. Empty = the agent's default model. Lower reasoning is faster, higher is more thorough.",
    shareNote:
      "Starts an ngrok tunnel to the local server. Open the link on your tablet to create and take courses. On first visit ngrok shows a warning page — tap “Visit Site”. Sharing stays on while the app is running.",
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
  // English by default; user can switch in Settings (preference is persisted).
  return "en";
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

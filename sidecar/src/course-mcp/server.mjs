#!/usr/bin/env node
// Learn (Almost) Anything — course MCP server.
//
// A thin, headless course-management layer for Claude Code. The model itself
// authors all course content (structure, articles, fact-checking, image search)
// using its own tools — this server NEVER calls an LLM. It only persists what
// the model produced to a local store, lists modules/lessons with statuses,
// lets the model edit the structure and update material, and publishes the
// finished course to a catalog (PUT /api/courses/<id> with a bearer token).
//
// Storage: one JSON file per course under $LAA_COURSE_STORE (default
// ~/.laa-course-mcp). Publishing builds a CatalogCoursePackage (schema v1) and
// PUTs it to $CATALOG_URL (overridable per call).

// Zero-dependency on purpose: only Node built-ins, so this single file runs
// anywhere `node` is available (incl. straight from the packaged .app bundle)
// without installing anything. MCP over stdio is newline-delimited JSON-RPC 2.0,
// which we implement inline below.
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";

const STORE_DIR = process.env.LAA_COURSE_STORE || join(homedir(), ".laa-course-mcp");
const SCHEMA_VERSION = 1;
const REFERENCE_FORMATS = new Set(["encyclopedia", "documentation"]);
const COURSE_FORMATS = [
  "academic_course",
  "mini_module",
  "podcast_series",
  "single_lesson",
  "encyclopedia",
  "documentation",
];

// ── store ──────────────────────────────────────────────────────────────────
const coursePath = (id) => join(STORE_DIR, `${id}.json`);
const nowSecs = () => Math.floor(Date.now() / 1000);

async function ensureStore() {
  await mkdir(STORE_DIR, { recursive: true });
}

async function loadCourse(id) {
  try {
    return JSON.parse(await readFile(coursePath(id), "utf8"));
  } catch {
    return null;
  }
}

async function saveCourse(course) {
  await ensureStore();
  course.updated_at = nowSecs();
  await writeFile(coursePath(course.id), JSON.stringify(course, null, 2));
  return course;
}

async function listCourseIds() {
  try {
    return (await readdir(STORE_DIR))
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5));
  } catch {
    return [];
  }
}

// ── structure helpers (arbitrary depth; documentation nests freely) ──────────
function flattenNodes(nodes, out = []) {
  for (const n of Array.isArray(nodes) ? nodes : []) {
    out.push(n);
    flattenNodes(n.submodules, out);
  }
  return out;
}

// Upsert an incoming tree against the existing one: keep an existing node's id
// (and thus its generated content) when provided, mint a fresh id otherwise.
function normalizeNodes(incoming, existingById) {
  return (Array.isArray(incoming) ? incoming : [])
    .map((n) => {
      const hasId = n && typeof n.id === "string" && existingById.has(n.id);
      const id = hasId ? n.id : (typeof n?.id === "string" && n.id) || randomUUID();
      const prev = existingById.get(id);
      return {
        id,
        title: String(n?.title ?? "").trim(),
        summary: String(n?.summary ?? "").trim(),
        generation_state: prev?.generation_state || "pending",
        test_passed: false,
        test_passed_at: null,
        prereqs: Array.isArray(n?.prereqs) ? n.prereqs : [],
        submodules: normalizeNodes(n?.submodules, existingById),
      };
    })
    .filter((n) => n.title);
}

function statusTree(course) {
  const decorate = (n) => ({
    id: n.id,
    title: n.title,
    status: course.lessons?.[n.id] ? "ready" : "pending",
    ...(n.submodules?.length ? { submodules: n.submodules.map(decorate) } : {}),
  });
  return (course.structure?.modules || []).map(decorate);
}

// ── catalog package + publish ────────────────────────────────────────────────
function buildPackage(course) {
  const isDoc = course.course_format === "documentation";
  const submodules = [];
  // Stamp generation_state from stored content, build the content list.
  const walk = (nodes, parentId) => {
    for (const n of nodes) {
      const lesson = course.lessons?.[n.id];
      n.generation_state = lesson ? "ready" : "pending";
      if (lesson) {
        submodules.push({
          module_id: isDoc ? "_doc" : parentId || n.id,
          submodule_id: n.id,
          article: lesson.article || "",
          widgets: lesson.widgets || {},
          sources: lesson.sources || [],
          test: lesson.test || [],
          review_notes: lesson.review_notes || "",
          assignments: lesson.assignments || [],
          flashcards: lesson.flashcards ?? null,
        });
      }
      walk(n.submodules || [], n.id);
    }
  };
  walk(course.structure?.modules || [], null);

  return {
    schema_version: SCHEMA_VERSION,
    exported_at: nowSecs(),
    course: {
      id: course.id,
      topic: course.topic,
      title: course.title,
      tags: course.tags || [],
      language: course.language,
      course_format: course.course_format,
      agent: course.agent || "claude",
      created_at: course.created_at,
      updated_at: course.updated_at,
      catalog_origin_id: course.id,
      catalog_version: nowSecs(),
    },
    course_md: course.course_md || "",
    structure: { course_id: course.id, modules: course.structure?.modules || [] },
    submodules,
    files: [],
  };
}

function normalizeBaseUrl(u) {
  return String(u || "").replace(/\/+$/, "");
}

async function publishToCatalog(course, catalogUrl, token) {
  const base = normalizeBaseUrl(catalogUrl || process.env.CATALOG_URL);
  const bearer = (token || process.env.CATALOG_UPLOAD_TOKEN || "").trim();
  if (!base) throw new Error("catalogUrl is required (or set CATALOG_URL)");
  if (!bearer) throw new Error("token is required (or set CATALOG_UPLOAD_TOKEN)");
  const pkg = buildPackage(course);
  if (!pkg.submodules.length) {
    throw new Error("course has no saved lessons to publish");
  }
  const url = `${base}/api/courses/${encodeURIComponent(course.id)}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
    body: JSON.stringify(pkg),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`catalog responded ${res.status}: ${text.slice(0, 400)}`);
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { url, lessons: pkg.submodules.length, response: body };
}

// ── tools ────────────────────────────────────────────────────────────────────
const NODE_SCHEMA = {
  type: "object",
  required: ["title"],
  properties: {
    id: { type: "string", description: "Keep an existing node's id to preserve its content; omit for new nodes." },
    title: { type: "string" },
    summary: { type: "string" },
    submodules: { type: "array", items: { type: "object" }, description: "Child nodes (same shape). Documentation may nest to any depth." },
  },
};

const TOOLS = [
  {
    name: "course_create",
    description:
      "Create a course record in the local store (no content yet). Returns its id. Choose course_format up front — it drives structure shape and what gets published. Reference formats (encyclopedia/documentation) have no tests/homework.",
    inputSchema: {
      type: "object",
      required: ["topic", "title", "language", "course_format"],
      properties: {
        id: { type: "string", description: "Optional explicit id; a uuid is generated otherwise." },
        topic: { type: "string" },
        title: { type: "string" },
        language: { type: "string", description: "BCP-47 / language name, e.g. 'en' or 'ru'." },
        course_format: { type: "string", enum: COURSE_FORMATS },
        tags: { type: "array", items: { type: "string" } },
        course_md: { type: "string", description: "Optional overview markdown for the course." },
        agent: { type: "string", description: "Provenance label only (default 'claude'). No LLM is called." },
      },
    },
  },
  {
    name: "course_set_structure",
    description:
      "Set or edit the course structure (modules → lessons; documentation nests to any depth). Idempotent upsert: pass an existing node's id to keep it (and its saved content), omit id for new nodes, drop a node to remove it (its content is discarded). Use this both to lay out the plan and to edit it later.",
    inputSchema: {
      type: "object",
      required: ["courseId", "modules"],
      properties: {
        courseId: { type: "string" },
        modules: { type: "array", items: NODE_SCHEMA, description: "Top-level sections/modules." },
      },
    },
  },
  {
    name: "course_status",
    description:
      "Return the course's module/lesson tree with each node's status (pending = no content yet, ready = content saved) plus counts. Use to see what still needs writing.",
    inputSchema: {
      type: "object",
      required: ["courseId"],
      properties: { courseId: { type: "string" } },
    },
  },
  {
    name: "course_set_space",
    description:
      "Attach (or update) a SPACE — the supplied material a course is grounded in. `strict` true = use ONLY this material (no outside knowledge/web); false = it's the primary base you may supplement. Stored on the course and returned by course_status so grounding persists across sessions. You read the dirs/sources/links yourself with your own tools.",
    inputSchema: {
      type: "object",
      required: ["courseId"],
      properties: {
        courseId: { type: "string" },
        strict: { type: "boolean", description: "Only use this material (default false)." },
        dirs: { type: "array", items: { type: "string" }, description: "Local directories to read with your file tools." },
        links: { type: "array", description: "Allowed URLs [{title?,url,kind?}] (or plain url strings)." },
        sources: { type: "array", description: "Documents [{title,kind?,path?,content?}] grounding the course." },
      },
    },
  },
  {
    name: "course_list",
    description: "List all courses in the local store with title, format, language and lesson counts.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "lesson_get",
    description: "Return a lesson's stored content (article, widgets, sources, test, assignments) so you can update it incrementally.",
    inputSchema: {
      type: "object",
      required: ["courseId", "lessonId"],
      properties: { courseId: { type: "string" }, lessonId: { type: "string" } },
    },
  },
  {
    name: "lesson_save",
    description:
      "Save or update one lesson's content that YOU wrote (article markdown + optional widgets/sources/test/assignments/flashcards). Marks the node 'ready'. The article may embed widget markers like ::widget{id=\"img-1\"} that reference keys in `widgets`. Call again to update material.",
    inputSchema: {
      type: "object",
      required: ["courseId", "lessonId", "article"],
      properties: {
        courseId: { type: "string" },
        lessonId: { type: "string", description: "The node id from the structure." },
        article: { type: "string", description: "Lesson markdown (may contain ::widget{...} markers and course://article/<Title> cross-links)." },
        widgets: { type: "object", description: "Map of widgetId → widget object (image/gallery/diagram/video/interactive/checkpoint)." },
        sources: { type: "array", description: "[{title,url}] references you actually used." },
        test: { type: "array", description: "Quiz questions (omit for reference formats)." },
        assignments: { type: "array", description: "Homework (omit for reference formats)." },
        flashcards: { type: "array", description: "SRS cards [{front,back}]." },
        review_notes: { type: "string" },
      },
    },
  },
  {
    name: "course_publish",
    description:
      "Publish the course to a catalog: builds a CatalogCoursePackage from saved lessons and PUTs it to <catalogUrl>/api/courses/<id> with a bearer token. Defaults to CATALOG_URL / CATALOG_UPLOAD_TOKEN env. Re-publish to push updates.",
    inputSchema: {
      type: "object",
      required: ["courseId"],
      properties: {
        courseId: { type: "string" },
        catalogUrl: { type: "string", description: "Catalog base URL (default $CATALOG_URL)." },
        token: { type: "string", description: "Upload token (default $CATALOG_UPLOAD_TOKEN)." },
      },
    },
  },
];

// ── tool handlers ─────────────────────────────────────────────────────────────
async function handleTool(name, args) {
  const a = args || {};
  switch (name) {
    case "course_create": {
      if (!COURSE_FORMATS.includes(a.course_format)) {
        throw new Error(`unknown course_format: ${a.course_format}`);
      }
      const id = (typeof a.id === "string" && a.id.trim()) || randomUUID();
      if (await loadCourse(id)) throw new Error(`course already exists: ${id}`);
      const course = {
        id,
        topic: String(a.topic),
        title: String(a.title),
        language: String(a.language),
        course_format: a.course_format,
        tags: Array.isArray(a.tags) ? a.tags : [],
        agent: typeof a.agent === "string" ? a.agent : "claude",
        course_md: typeof a.course_md === "string" ? a.course_md : "",
        created_at: nowSecs(),
        updated_at: nowSecs(),
        structure: { modules: [] },
        lessons: {},
      };
      await saveCourse(course);
      return { courseId: id, status: "created" };
    }

    case "course_set_structure": {
      const course = await loadCourse(a.courseId);
      if (!course) throw new Error(`course not found: ${a.courseId}`);
      const existingById = new Map(
        flattenNodes(course.structure?.modules).map((n) => [n.id, n])
      );
      course.structure = { modules: normalizeNodes(a.modules, existingById) };
      // Drop saved content for nodes that no longer exist in the tree.
      const keptIds = new Set(flattenNodes(course.structure.modules).map((n) => n.id));
      for (const lid of Object.keys(course.lessons || {})) {
        if (!keptIds.has(lid)) delete course.lessons[lid];
      }
      await saveCourse(course);
      return { courseId: course.id, nodes: keptIds.size, modules: statusTree(course) };
    }

    case "course_set_space": {
      const course = await loadCourse(a.courseId);
      if (!course) throw new Error(`course not found: ${a.courseId}`);
      course.space = {
        strict: a.strict === true,
        dirs: Array.isArray(a.dirs) ? a.dirs : [],
        links: Array.isArray(a.links) ? a.links : [],
        sources: Array.isArray(a.sources) ? a.sources : [],
      };
      await saveCourse(course);
      return { courseId: course.id, space: course.space };
    }

    case "course_status": {
      const course = await loadCourse(a.courseId);
      if (!course) throw new Error(`course not found: ${a.courseId}`);
      const all = flattenNodes(course.structure?.modules);
      const ready = all.filter((n) => course.lessons?.[n.id]).length;
      return {
        courseId: course.id,
        title: course.title,
        course_format: course.course_format,
        total: all.length,
        ready,
        pending: all.length - ready,
        ...(course.space ? { space: course.space } : {}),
        modules: statusTree(course),
      };
    }

    case "course_list": {
      const ids = await listCourseIds();
      const out = [];
      for (const id of ids) {
        const c = await loadCourse(id);
        if (!c) continue;
        const all = flattenNodes(c.structure?.modules);
        out.push({
          id: c.id,
          title: c.title,
          course_format: c.course_format,
          language: c.language,
          total: all.length,
          ready: all.filter((n) => c.lessons?.[n.id]).length,
          updated_at: c.updated_at,
        });
      }
      return { courses: out };
    }

    case "lesson_get": {
      const course = await loadCourse(a.courseId);
      if (!course) throw new Error(`course not found: ${a.courseId}`);
      const node = flattenNodes(course.structure?.modules).find((n) => n.id === a.lessonId);
      if (!node) throw new Error(`lesson not found in structure: ${a.lessonId}`);
      return { courseId: course.id, lessonId: a.lessonId, title: node.title, content: course.lessons?.[a.lessonId] || null };
    }

    case "lesson_save": {
      const course = await loadCourse(a.courseId);
      if (!course) throw new Error(`course not found: ${a.courseId}`);
      const nodes = flattenNodes(course.structure?.modules);
      const node = nodes.find((n) => n.id === a.lessonId);
      if (!node) throw new Error(`lesson id not in structure: ${a.lessonId} — add it via course_set_structure first`);
      if (typeof a.title === "string" && a.title.trim()) node.title = a.title.trim();
      node.generation_state = "ready";
      course.lessons = course.lessons || {};
      course.lessons[a.lessonId] = {
        article: String(a.article || ""),
        widgets: a.widgets && typeof a.widgets === "object" ? a.widgets : {},
        sources: Array.isArray(a.sources) ? a.sources : [],
        test: Array.isArray(a.test) ? a.test : [],
        assignments: Array.isArray(a.assignments) ? a.assignments : [],
        flashcards: Array.isArray(a.flashcards) ? a.flashcards : null,
        review_notes: typeof a.review_notes === "string" ? a.review_notes : "",
        updated_at: nowSecs(),
      };
      await saveCourse(course);
      const ready = nodes.filter((n) => course.lessons?.[n.id]).length;
      return { courseId: course.id, lessonId: a.lessonId, status: "ready", ready, total: nodes.length };
    }

    case "course_publish": {
      const course = await loadCourse(a.courseId);
      if (!course) throw new Error(`course not found: ${a.courseId}`);
      const result = await publishToCatalog(course, a.catalogUrl, a.token);
      return { courseId: course.id, published: true, ...result };
    }

    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// ── MCP over stdio (newline-delimited JSON-RPC 2.0) ──────────────────────────
const PROTOCOL_VERSION = "2024-11-05";
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const replyError = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

async function dispatch(method, params, id) {
  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "laa-course", version: "0.1.0" },
      });
    case "tools/list":
      return reply(id, { tools: TOOLS });
    case "tools/call": {
      const { name, arguments: args } = params || {};
      try {
        const result = await handleTool(name, args);
        return reply(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
      } catch (e) {
        return reply(id, {
          isError: true,
          content: [{ type: "text", text: `Error in ${name}: ${e?.message || String(e)}` }],
        });
      }
    }
    case "ping":
      return reply(id, {});
    default:
      return replyError(id, -32601, `method not found: ${method}`);
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return; // ignore non-JSON noise
  }
  // Notifications (no id) — e.g. notifications/initialized — need no response.
  if (msg.id === undefined || msg.id === null) return;
  try {
    await dispatch(msg.method, msg.params, msg.id);
  } catch (e) {
    replyError(msg.id, -32603, e?.message || String(e));
  }
});

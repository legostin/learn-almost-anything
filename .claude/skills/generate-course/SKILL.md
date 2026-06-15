---
name: generate-course
description: Generate a full Learn (Almost) Anything course (any format) yourself and publish it to a catalog. YOU write the structure, articles, fact-checks and image picks with your own tools; the laa-course MCP only persists, lists status, edits structure, and publishes. Use when asked to create/author/generate a course, encyclopedia, documentation, lesson or podcast-series and put it in the local/private catalog.
---

# Generate a course (you author, the MCP persists & publishes)

You produce **all** course content yourself — structure design, article writing,
fact-checking (via your web search), image selection (via your web/image search)
— using your normal tools. The **`laa-course` MCP server never calls an LLM**; it
only saves what you wrote, tracks lesson status, lets you edit the structure, and
publishes the finished course to a catalog. This keeps generation inside Claude
Code (no paid external model calls).

## Prerequisites

- The `laa-course` MCP server is registered (see `.mcp.json` at the repo root).
  Its tools: `course_create`, `course_set_structure`, `course_status`,
  `course_list`, `lesson_get`, `lesson_save`, `course_publish`.
- Catalog target: set `CATALOG_URL` and `CATALOG_UPLOAD_TOKEN` in the MCP env
  (`.mcp.json`), or pass `catalogUrl`/`token` to `course_publish`. For a local
  self-hosted catalog that's usually `http://localhost:8080` + its upload token.

## Workflow

### 1. Clarify (don't guess)
Ask the user what's missing before writing: exact topic/scope, **format**,
target reader & level, language, and depth. Map intent → `course_format`:
- `academic_course` — progressive curriculum (modules → lessons, tests + homework).
- `mini_module` — one tight practical module.
- `single_lesson` — one standalone article.
- `podcast_series` — listenable episode scripts, no tests/homework/widgets.
- `encyclopedia` — interlinked reference articles in sections (no tests/homework).
- `documentation` — like encyclopedia but "how something works"; **nests to any
  depth** and every node is an article.

### 2. Create + lay out structure
- `course_create({ topic, title, language, course_format, tags? })` → `courseId`.
- Design the plan, then `course_set_structure({ courseId, modules })`.
  - `modules` is a tree of `{ title, summary?, submodules? }`. For most formats
    it's 2 levels (module → lesson). For `documentation` nest freely:
    `submodules` can contain `submodules`.
  - Re-call it any time to **edit** the structure: pass an existing node's `id`
    (from `course_status`) to keep it and its saved content; omit `id` for new
    nodes; drop a node to delete it.

### 3. Write each lesson (your job)
For every node, check `course_status` to see what's still `pending`, then:
1. **Research** the subtopic with web search; only state facts you can source.
   For accuracy-critical topics, verify load-bearing claims (fact-check pass).
2. **Write** the article in markdown, in the course language, matching the
   format (reference formats = complete standalone articles; podcast = spoken
   script; course/lesson = teach progressively).
3. **Images**: find real image URLs via web/image search; reference them as
   widgets (see below). Don't invent URLs.
4. Save it: `lesson_save({ courseId, lessonId, article, widgets?, sources?, test?, assignments?, flashcards? })`.
   - `lessonId` is the node `id` from `course_status`.
   - **Skip `test`/`assignments`** for reference (encyclopedia/documentation) and
     podcast formats.
   - `sources` = `[{title,url}]` you actually used.

#### Widgets & cross-links (in `article` + `widgets`)
- Embed a widget with a marker `::widget{id="img-1"}` on its own line, and put the
  object in `widgets` under that key. Image widget:
  `{ "type":"image", "url":"https://…", "alt":"…", "description":"caption" }`.
  Also: `gallery` (`items:[…]`), `diagram` (`{type:"diagram",source:"<mermaid>"}`),
  `video` (`{type:"video",url:"…",title:"…"}`), `checkpoint`
  (`{type:"checkpoint",question,answer}`).
- **Cross-links** (encyclopedia/documentation): link another article with
  `[Title](course://article/<Exact Title>)` — the catalog resolves it. Only link
  to titles that exist in the structure.

### 4. Publish
When enough lessons are `ready`:
`course_publish({ courseId })` (uses `CATALOG_URL`/`CATALOG_UPLOAD_TOKEN`), or pass
`catalogUrl`/`token`. It builds a CatalogCoursePackage and PUTs it to
`<catalogUrl>/api/courses/<id>`. The course then appears in the catalog with the
nested plan and working cross-links.

### 5. Update later
Re-run `lesson_save` to update material, `course_set_structure` to edit the tree,
then `course_publish` again to push the update.

## Tips
- Use `course_list` to find existing courses; `course_status` before/after writing.
- Generate breadth-first or section-by-section; you don't have to write every
  lesson before publishing — publish what's `ready`, fill the rest, re-publish.
- Keep titles unique within a course so cross-links resolve unambiguously.

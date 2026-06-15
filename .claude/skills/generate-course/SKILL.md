---
name: generate-course
description: Generate a full Learn (Almost) Anything course (any format) yourself and publish it to a catalog. YOU write the structure, articles, fact-checks, image picks and source citations with your own tools — including domain-specific research and courses grounded in supplied docs/repos (spaces); the laa-course MCP only persists, lists status, edits structure, and publishes. Use when asked to create/author/generate a course, encyclopedia, documentation, lesson or podcast-series, optionally from given material, and put it in the local/private catalog.
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
  Its tools: `course_create`, `course_set_structure`, `course_set_space`,
  `course_status`, `course_list`, `lesson_get`, `lesson_save`, `course_publish`.
- Catalog target: set `CATALOG_URL` and `CATALOG_UPLOAD_TOKEN` in the MCP env
  (`.mcp.json`), or pass `catalogUrl`/`token` to `course_publish`. For a local
  self-hosted catalog that's usually `http://localhost:8080` + its upload token.

## Reference files (load on demand — keep this skill lean)

Read the matching file from `references/` only when you reach that step, not up
front:
- `references/domains.md` — classify the topic into one domain; per-domain
  preferred sources, research strategy, pedagogy, and fact-check rigor.
- `references/spaces.md` — when the course is grounded in supplied docs / a repo
  / specific sites (a "space"): strict vs primary mode, how to read & cite it.
- `references/fact-checking.md` — the fact-check procedure and which domains
  always need it.
- `references/images.md` — image search vs generation, query rules, min size,
  widget shapes.
- `references/editing-and-sources.md` — updating material and honest sourcing.

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

Also detect a **space**: if the user wants the course built from supplied
material (specific docs, a code repo / local folder, or a fixed set of sites),
that's a space — read `references/spaces.md` and ask whether it's *strict*
(only that material) or *primary* (that material is the base, you may supplement).

### 2. Create + lay out structure
- `course_create({ topic, title, language, course_format, tags? })` → `courseId`.
  Add the chosen domain (see `references/domains.md`) as a tag.
- If there's a space, persist it:
  `course_set_space({ courseId, strict, sources, links, dirs })`. Ground the plan
  and every lesson in it per `references/spaces.md`.
- Design the plan, then `course_set_structure({ courseId, modules })`.
  - `modules` is a tree of `{ title, summary?, submodules? }`. For most formats
    it's 2 levels (module → lesson). For `documentation` nest freely:
    `submodules` can contain `submodules`.
  - Re-call it any time to **edit** the structure: pass an existing node's `id`
    (from `course_status`) to keep it and its saved content; omit `id` for new
    nodes; drop a node to delete it.

### 3. Write each lesson (your job)
First, classify the domain and read `references/domains.md` once (preferred
sources, research strategy, pedagogy, fact-check rigor for this kind of subject).
Then for every `pending` node (from `course_status`):
1. **Research** with web search using the domain's preferred sources; only state
   facts you can source. If the course has a space, ground in it (`spaces.md`).
2. **Write** the article in markdown, in the course language, matching the format
   (reference = complete standalone articles; podcast = spoken script;
   course/lesson = teach progressively per the domain pedagogy).
3. **Fact-check** load-bearing claims — always for science_math/health/business/
   data_ai; see `references/fact-checking.md`.
4. **Illustrate** — search real images or generate/diagram per
   `references/images.md`; reference them as widgets.
5. **Save**: `lesson_save({ courseId, lessonId, article, widgets?, sources?, test?, assignments?, flashcards? })`.
   - `lessonId` is the node `id` from `course_status`.
   - **Skip `test`/`assignments`** for reference (encyclopedia/documentation) and
     podcast formats.
   - `sources` = honest `[{title,url}]` you actually used (`editing-and-sources.md`).

#### Widgets & cross-links (in `article` + `widgets`)
- Embed a widget with a marker `::widget{id="img-1"}` on its own line, and put the
  object in `widgets` under that key (shapes in `references/images.md`):
  image / `gallery` / `diagram` (Mermaid) / `video` / `checkpoint`.
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
Re-run `lesson_save` to update material (see `references/editing-and-sources.md`
for editing a specific fragment vs deepening), `course_set_structure` to edit the
tree, `course_set_space` to adjust grounding, then `course_publish` again to push
the update.

## Tips
- Use `course_list` to find existing courses; `course_status` before/after writing.
- Generate breadth-first or section-by-section; you don't have to write every
  lesson before publishing — publish what's `ready`, fill the rest, re-publish.
- Keep titles unique within a course so cross-links resolve unambiguously.

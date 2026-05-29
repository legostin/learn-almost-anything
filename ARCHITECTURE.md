# Architecture — Learn (Almost) Anything

> A local-first desktop tutor that turns any topic into a personalised course.
> Courses are authored by Claude or Codex through the user's own subscription —
> no API keys, no servers, no telemetry.

This document describes the codebase as it actually is, not as it was once
planned. Each section names the files it talks about so the doc can be checked
against reality.

---

## 1. Process model

The app is three processes that talk over two transports:

```
┌──────────────────────────────────────────────────────────────────────────┐
│                       Tauri desktop bundle                                │
│                                                                            │
│  ┌─────────────────────────────┐        ┌──────────────────────────────┐  │
│  │  React 19 + Vite (WebView)  │ ◀IPC▶ │   Rust core (src-tauri/)     │  │
│  │  src/App.tsx                │        │   lib.rs / courses / db /    │  │
│  │  src/transport.ts           │        │   settings / media / share   │  │
│  │  - wizard / structure       │        │   - SQLite (rusqlite)        │  │
│  │  - article reader           │        │   - filesystem layout        │  │
│  │  - widget host              │        │   - HTTP /api server         │  │
│  │  - assignments              │        │   - background workers       │  │
│  │  - audio player             │        │                              │  │
│  └─────────────────────────────┘        └────────────┬─────────────────┘  │
│                                                       │ JSON-RPC / stdio   │
│                                          ┌────────────▼─────────────────┐  │
│                                          │   Node sidecar                │  │
│                                          │   sidecar/src/index.mjs       │  │
│                                          │   - Claude Agent SDK          │  │
│                                          │   - Codex SDK                 │  │
│                                          │   - widget validator          │  │
│                                          └──────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
                            │                       │
                            ▼                       ▼
                ~/Library/Application Support/   embedded HTTP :8787
                com.legostin.learnanything/      + optional ngrok tunnel
                ├── learn-anything.db
                ├── courses/<id>/…
                ├── settings.json
                └── tts_cache/<fnv1a>.wav
```

- **Rust core** owns persistence, file IO, secrets, the background job
  pipeline, image post-processing, and the HTTP bridge that lets a remote
  browser tab control the same app.
- **Node sidecar** owns every LLM call. It is a single process started at
  launch and reused for the session; it exposes a tiny JSON-RPC protocol over
  its stdio. See `src-tauri/src/sidecar.rs` (Rust side) and
  `sidecar/src/index.mjs` (Node side).
- **React frontend** is one SPA. It runs inside the Tauri WebView on the
  desktop, but the same bundle is served by the embedded HTTP server when the
  user shares the app, so it also runs in a normal browser tab.

The bundle identifier `com.legostin.learnanything` and the database filename
`learn-anything.db` are stable: changing either would orphan every user's
existing courses, so they are intentionally kept under the older project name.

---

## 2. Sidecar protocol

Line-delimited JSON over stdin/stdout. Defined in `sidecar/src/index.mjs`:

```
Request:  {"id": <string>, "method": <string>, "params": <object>}
Response: {"id": <string>, "result": <any>}
Error:    {"id": <string>, "error": <string>}
Progress: {"progress": {"id": <string>, "label": <string>, "detail"?: <string>}}
```

Progress frames are emitted zero or more times **before** the matching
`Response`. The Rust side (`sidecar::Sidecar::call_with_progress`) forwards them
into `agent_stage` Tauri events so the UI sees live status without polling.

Backend selection is a `backend: "claude" | "codex"` field on every LLM
method's params. The dispatcher routes to the matching agent module.

Methods exposed (`sidecar/src/index.mjs`):

| Method                      | Purpose                                                |
|-----------------------------|--------------------------------------------------------|
| `wizard_questions`          | Generate 3–7 clarifying questions for the wizard        |
| `build_structure`           | Research and propose the full module/submodule tree     |
| `refine_structure`          | Apply a user chat message to the current structure      |
| `submodule_draft`           | Write the article + pick widget placeholders            |
| `submodule_annotate`        | JS-only Mermaid sanity-check + interactive widget repair|
| `submodule_review_images`   | Vision pass picks the best Brave-search candidate       |
| `generate_test`             | Multiple-choice comprehension test                      |
| `generate_assignments`      | Homework assignment chain                               |
| `review_assignment`         | Grade a learner submission (text / image / archive / GitHub) |
| `generate_image`            | Codex `$imagegen` wrapper (Claude has no image gen)     |
| `list_models`               | Live model catalog from the CLI                         |
| `chat`, `claude_chat`       | One-shot smoke-test                                     |

Both backends implement the same surface in `sidecar/src/agents/claude.mjs` and
`sidecar/src/agents/codex.mjs`.

### 2.1 Claude isolation

Every Claude `query()` call is built through `buildClaudeOptions` in
`claude.mjs` with a fixed isolation block:

```js
const AGENT_ISOLATION = { settingSources: [], permissionMode: "dontAsk" };
```

- `settingSources: []` prevents the SDK from loading the user's global Claude
  config. Without this, the embedded agent would inherit whatever MCP servers
  the user has installed (godot, blender, …) and could hang on a permission
  prompt nothing can answer in headless mode.
- `permissionMode: "dontAsk"` runs only the tools listed in `allowedTools` and
  denies anything else instantly instead of prompting.

The Rust sidecar spawner also strips `ANTHROPIC_API_KEY` from the child's env
so the agent always falls back to the local CLI subscription auth.

### 2.2 Web access

Claude gets `WebSearch` + `WebFetch` added to `allowedTools` whenever a
content stage runs (`draftArticleInternal`, `buildStructure`,
`refineStructure`). These are the SDK's built-in tools — they work on the
user's subscription with no key required. When a Brave API key is configured,
the Brave MCP server is added on top via `sidecar/src/lib/brave.mjs`; it
resolves the installed package directly to avoid a per-call `npx` cold start.

Codex has native `webSearchEnabled: true` on every thread, so its web access
is unconditional.

---

## 3. Persistence layout

### 3.1 SQLite — metadata only

Schema lives in `src-tauri/migrations/`:

```sql
courses (id, topic, language, status, agent, created_at, updated_at)
modules (id, course_id, parent_id, position, title, summary, generation_state)
progress (module_id, test_passed_at, marked_done_at)
jobs    (id, course_id, module_id, kind, status, agent, …)
```

`agent` is per-course (Claude or Codex) and was added by `V2__add_course_agent.sql`.
`generation_state ∈ { pending, generating, ready, failed }`. The `jobs` table
exists for future job inspection but the live pipeline streams progress via
events rather than polling rows.

At startup `db::reset_stuck_generations` flips any `generating` row left over
from a previous process back to `failed`, since the worker thread that owned
it died with the previous app process.

### 3.2 Filesystem — everything else

Content lives under the per-platform `app_data_dir`, namespaced by course:

```
courses/<course_id>/
├── course.md                              # wizard answers, plain markdown
├── structure.json                         # full tree mirror of the SQLite rows
├── chat.json                              # structure-refinement chat history
├── memory/                                # accepted refinement memos (.md)
└── modules/<mod_id>/<sub_id>/
    ├── article.md                         # the lesson
    ├── widgets.json                       # widget data keyed by id
    ├── sources.json                       # citations the agent surfaced
    ├── review-notes.md                    # validator/self-review notes
    ├── test.json                          # comprehension questions
    ├── assignments.json                   # homework chain
    ├── checkpoint.json                    # draft resume snapshot (deleted on success)
    ├── error.txt                          # last failure message (deleted on success)
    ├── images/                            # final illustration JPEGs
    │   └── _candidates/                   # search candidates, cleaned after pick
    └── assignments/<assignment_id>/
        ├── status.json
        ├── chat.json
        └── uploads/attempt-N/<file>       # learner submissions
```

Content is kept on disk rather than in the DB so it stays inspectable,
diff-able, and easy for agents to read or rewrite via plain file IO. Tools and
status are written through helpers in `src-tauri/src/courses.rs`.

### 3.3 Secrets and settings

`settings.json` (`SettingsState` in `src-tauri/src/settings.rs`) holds the
Brave key, Gemini key, ngrok reserved domain(s), per-stage model preferences,
and the TTS engine/voice/model choice. It is never committed to the repo. The
Tauri commands `set_brave_key`, `set_gemini_key`, `set_model_settings`,
`set_tts_*`, `set_gemini_*_model`, etc. each persist immediately.

The TTS audio cache lives at `tts_cache/<fnv1a_hex>.wav` keyed by
`voice|model|text` so the same chunk is paid for at most once.

---

## 4. Submodule generation pipeline

`spawn_generate_submodule` in `src-tauri/src/lib.rs` is the core orchestrator.
Every stage emits `agent_stage` events for live UI, persists artefacts as soon
as they are durable, and soft-fails on enrichment errors. The key property is
that the article — the only artefact the learner actually needs to start
reading — is written and the submodule is marked `ready` **before**
illustrations, tests, and assignments finish. Everything else backfills.

```
spawn_generate_submodule
│
├─ stage: draft         (sidecar.submodule_draft)
│  • web-search + write article + widget placeholders
│  • on transient failure: retry up to 3× with on_retry progress
│  • on success: checkpoint.json → checkpoint.json deleted only after success
│  • on resume: skip if the checkpoint already has stage="draft"
│
├─ stage: annotate      (sidecar.submodule_annotate)
│  • JS-only Mermaid sanity check, interactive widget repair loop
│  • soft-fail: notes are appended, originals kept
│
├─ persist article + widgets + sources + notes
├─ set generation_state = "ready"
├─ emit agent_job { ok: true, enriching: true }
│  ← reader is now usable
│
├─ background: test         (sidecar.generate_test)        ── parallel
├─ background: assignments  (sidecar.generate_assignments) ── parallel
└─ stage: illustrate
   • Per image widget marked mode="generate": Gemini (or Codex $imagegen) ──┐
   • Per image widget marked mode="search":   Brave → download → vision pick │
   • Up to 3 search rounds with refined query                                 │
   • Per-widget concurrency capped at 3                                       │
       (illustrate_widgets + illustrate_one_widget in lib.rs)
   • Falls back to placeholder if neither generate nor search succeeds

… join test + assignments threads
… persist widgets + test + assignments (all non-fatal on write)
… emit agent_enrich  ── tells an open reader to reload
… emit agent_assignments ── tells the reader to mount homework
```

Timings for every stage are recorded by `log_timing` (stderr + `agent_stage`
"готово" event with a duration), so the real per-stage cost is observable in
the UI transcript.

### 4.1 Retries and resume

`retry_stage` in `lib.rs` runs the draft up to `STAGE_MAX_ATTEMPTS = 3` times,
calling an `on_retry(next_attempt, last_error)` callback so the UI shows the
retry number and the last error. The annotate / test / assignments /
illustrate stages do **not** retry: they are soft-fail enrichments, the
article is already saved.

If the process dies mid-draft, `checkpoint.json` lets a future
`start_generate_submodule` resume with the article+widgets+sources already
drafted, skipping straight to annotate. The checkpoint and `error.txt` are
deleted as soon as the article is durable.

### 4.2 Capability gates

Before launching, the orchestrator decides whether illustration is even
possible:

```rust
let can_illustrate = brave_api_key.is_some() || gemini_key.is_some() || course.agent == "codex";
```

If none is available the stage is skipped entirely and the article keeps its
placeholder widgets. Generate mode prefers Gemini (`media::gemini_generate_image`)
and falls back to Codex `$imagegen` when the course is Codex. Search mode
needs a Brave key.

---

## 5. Widgets

Articles are markdown with inline placeholders `::widget{id="w1"}`. The
frontend (`src/App.tsx::splitWidgetMarkers` → `WidgetRenderer`) walks each
article and renders the matching entry from `widgets.json`.

Four widget types are supported today:

| Type          | Source / runtime                                                     |
|---------------|----------------------------------------------------------------------|
| `image`       | JPEG on disk (illustration pipeline) or external URL                 |
| `diagram`     | Mermaid source rendered client-side                                  |
| `video`       | Recommended URL (YouTube etc.) embedded via `videoEmbedUrl`          |
| `interactive` | Vanilla HTML + CSS + JS, rendered inside a sandboxed `<iframe>` with a strict CSP from `buildInteractiveDoc` (matches `sidecar/src/lib/interactive.mjs`) |

### 5.1 Interactive widget validation

Mini-apps are the only widget type that *can* fail in interesting ways, so
they go through a multi-stage validator in `interactive.mjs`:

1. **Static lint** — size cap (8 KB total), regex blocklist (no `eval`,
   `new Function`, `fetch`, `iframe`, storage APIs, etc.), `new Function(js)`
   to catch syntax errors without executing.
2. **Runtime check** — `jsdom` with `runScripts: "outside-only"`, a virtual
   console capturing errors, and a 1.5s settle window for `setTimeout` /
   `requestAnimationFrame`.
3. **Visual render** (optional) — `playwright-core` with `channel: "chrome"`
   reuses the user's installed Chrome (no Chromium download) to screenshot
   the widget. A vision agent then inspects the PNG; if it flags a render
   defect, the error is fed into the same repair loop as the lint/runtime
   stages (`validateAndRepairInteractive` in both agents). The whole visual
   stage self-disables if Chrome isn't present so the validator still works.

The repair loop runs at most `INTERACTIVE_MAX_REPAIRS = 2` rounds; on
exhaustion the original widget is kept with a noted defect rather than
removed.

The frontend renders interactives inside `<iframe sandbox="allow-scripts">` so
even if a malicious script slipped past validation it still cannot reach the
host page.

---

## 6. Illustrations

`illustrate_widgets` (`lib.rs`) consumes the image-widget descriptions the
draft agent left behind and resolves each one into a final JPEG on disk:

- Widgets with `mode = "generate"`: call `media::gemini_generate_image` first
  (model from `settings.gemini_image_model`, default
  `gemini-2.5-flash-image`); on failure for Codex courses, fall back to
  `generate_image` via the sidecar (Codex's `$imagegen` writes a file under
  `~/.codex/generated_images/`, picked up by mtime).
- Widgets with `mode = "search"`: up to 3 search rounds against
  `media::brave_image_search`. Each round downloads up to 3 candidates in
  parallel (`download_resize_jpeg`), then calls
  `sidecar.submodule_review_images` — a vision pass that either picks an
  index or suggests a refined query for the next round.

Jobs run on a bounded thread scope (`concurrency = min(jobs.len(), 3)`) so a
submodule with many images doesn't blow past Brave's rate limit. Picked
candidates are copied into `images/<wid>.jpg`; the `_candidates/` umbrella is
removed at the end.

---

## 7. Homework / assignments

For each submodule the draft pipeline kicks off a parallel
`generate_assignments` call. The agent returns a short chain of assignments,
each with a type from `{image, text, document, archive, github}` and a
criticality (`critical | major | minor`). Definitions are stored in
`assignments.json`.

`submit_assignment` (`lib.rs`):

1. Sanitises the filename (`sanitize_filename`) so a malicious upload name
   cannot escape the assignment's uploads dir.
2. Stores each upload under
   `assignments/<aid>/uploads/attempt-N/<safe-name>`.
3. Extracts text from `.zip` archives via the `zip` crate or as UTF-8 from any
   document upload (`courses::extract_submission_text`); images become
   `local_image` references for the vision pass.
4. Builds the prior chat history, calls `sidecar.review_assignment`, and
   appends both the learner turn and the reviewer turn to `chat.json`.
5. Writes the new status (`passed` or `in_progress`) to `status.json` and
   emits `agent_assignments` so the open reader refreshes.

`start_generate_assignments` is the same flow on demand, for submodules that
were generated before the homework system existed.

---

## 8. Lecture audio

Each article has a "Listen" button (`LectureAudio` in `App.tsx`). The
`AudioPlayerProvider` chunks the article (`articleToSpeechText` strips
markdown / widget markers; `chunkSpeech` cuts to ~220-char sentences),
caches per-chunk audio, prefetches the next chunk while the current one
plays, and renders a sticky footer (`StickyPlayer`) plus a fullscreen view
(`ExpandedPlayer`) with ±10s skip and a seek bar.

Two engines:

- **`system`** (default) — `window.speechSynthesis`. Free, runs locally, no
  config needed.
- **`gemini`** — paid Gemini TTS. Only selectable in the Settings modal when
  a Gemini key is configured. The Rust command `synthesize_speech` is
  `async`, runs the multi-second HTTP request inside `spawn_blocking` so the
  UI never freezes, and caches each WAV under
  `tts_cache/<fnv1a64(voice|model|text)>.wav` — the same lecture chunk is
  paid for at most once.

The voice and model are pickers in Settings. The Gemini model lists are
fetched live from `media::list_gemini_models` (Gemini ListModels filtered by
name patterns) rather than hard-coded.

---

## 9. Sharing (remote viewer)

When the user hits "Share", the app:

1. Spawns `ngrok` against the local port (`share::start_ngrok`,
   `SHARE_PORT = 8787`). If a reserved domain is configured, ngrok binds to it.
2. Polls the ngrok admin API on `:4040` until the public HTTPS URL appears.
3. Returns the URL; the user shows the QR code or sends the link.

The embedded HTTP server (`tiny_http`, started in `share::start_http_server`
on app boot, not on share start) speaks three endpoints:

| Path             | Behaviour                                                              |
|------------------|------------------------------------------------------------------------|
| `/api/cmd/<n>`   | Dispatch a Tauri command by name; JSON body becomes the args           |
| `/api/events`    | Long-poll for `agent_job`, `agent_stage`, `agent_enrich`, `agent_assignments` events since cursor |
| `/media?path=…`  | Serve a widget image / audio file by absolute path (scoped)            |
| `/` (else)       | Serve the same React bundle the desktop loads                          |

The frontend `transport.ts` abstracts away the difference: in the native
WebView it calls Tauri IPC and listens on Tauri events; in a remote browser
it calls `/api/cmd/*` and runs a single shared long-poll loop over
`/api/events`, fanning out to component listeners. Components never know
which side they are on.

The event hub (`src-tauri/src/events.rs`) is a bounded in-memory ring buffer
(1000 events) that mirrors every Tauri-emit. Remote clients catch up by
passing the last seq cursor; the desktop WebView still uses native Tauri
emit and ignores the hub.

---

## 10. Frontend layout

A single SPA in `src/App.tsx` (large by design — splitting buys nothing for a
single-window desktop app, and keeps all the audio/transport state in scope).
Major components:

- `App` — root router by selected course / wizard step.
- `CapabilityBanners` — shows missing-agent and missing-Brave warnings up
  front so the user knows what won't work before they try.
- `CreateCourse` / `Wizard` / `Structure` / `StructureBuilder` /
  `RefineChat` — course creation flow.
- `CourseView` / `StructureTree` / `SubmoduleAction` — the left nav.
- `SubmoduleView` — wraps `ArticleReader`, `LiveActivity` (stage strip),
  `AgentTranscript`, `TestSection`, `AssignmentsSection`, `SourcesList`.
- `WidgetRenderer` dispatches to `ImagePlaceholder`, `DiagramWidget`,
  `VideoWidget`, `InteractiveWidget` (sandboxed iframe via
  `buildInteractiveDoc`).
- `AudioPlayerProvider` / `useAudioPlayer` / `StickyPlayer` / `ExpandedPlayer`
  / `LectureAudio` — the audio subsystem.
- `SettingsModal` — keys, models per stage, TTS engine/voice/model, share
  domains.

UI strings live in `src/i18n.tsx` (en + ru). The default language is English
unless the user has stored another choice in `localStorage`.

---

## 11. Models and reasoning

`SettingsState::stage_model(backend, category)` (`settings.rs`) returns a
JSON blob `{model, reasoning}` for the requested combination, e.g.
`("claude", "planning")` for structure / wizard, `("claude", "writing")` for
the article draft, `("claude", "tests")` for tests and assignments.

The sidecar maps `reasoning` onto SDK-specific fields:

- Claude (`modelOptions` in `claude.mjs`):
  `off | none | disabled` → `thinking: {type: "disabled"}`;
  `low | medium | high | xhigh | max` → `effort: <value>`.
- Codex (`modelThreadOptions` in `codex.mjs`): the same vocabulary maps onto
  Codex's `reasoning.effort` (or disables it).

Empty fields are dropped so the agent falls back to its built-in default —
the user only sets the levers they care about.

The model picklists in Settings come from `sidecar.list_models` — a cached
call to the CLI's `supportedModels()` so each entry carries the effort levels
that specific model actually supports.

---

## 12. Build and distribution

- `scripts/copy-sidecar.mjs` mirrors `sidecar/` into
  `src-tauri/sidecar/` (excluding `*_test.mjs` and logs) before the Tauri
  bundle is built. `tauri.conf.json::bundle.resources = ["sidecar/**"]`
  ships that copy with the app.
- At runtime, `sidecar_script_path` in `lib.rs` first looks for the bundled
  `resource_dir/sidecar/src/index.mjs`; in dev it falls back to the source
  tree sibling.
- The Tauri crate is `learn-almost-anything` (lib name
  `learn_almost_anything_lib`); the npm package is `learn-almost-anything`;
  the sidecar package is `learn-almost-anything-sidecar`.
- `.github/workflows/release.yml` builds macOS (universal) and Windows (x64)
  with `tauri-apps/tauri-action@v0`; tag pushes (`v*`) cut a draft release,
  workflow-dispatch runs upload artefacts only.

---

## 13. What this app is not

- **Not multi-user.** No accounts, no sync, no shared cloud state. Sharing is
  a transient tunnel to your own machine, not a service.
- **Not server-backed.** The app is the server. There is no SaaS.
- **Not vendor-locked to a model.** Claude and Codex are interchangeable; the
  user picks per course.
- **Not a sandbox for arbitrary code execution.** Interactive widgets are
  vanilla DOM/JS only, validated and rendered inside a sandboxed iframe with
  a strict CSP. There is no plugin system.
- **Not free of dependencies the user already has.** It relies on the local
  `claude` and/or `codex` CLI for subscription auth, optionally on a
  Brave Search key, optionally on a Gemini key, optionally on the system
  Chrome for widget visual checks, optionally on `ngrok` for sharing. Each
  one is checked at start (`check_agent_availability`,
  `get_settings_status`) and surfaced in `CapabilityBanners` so the user
  knows what is and isn't on.

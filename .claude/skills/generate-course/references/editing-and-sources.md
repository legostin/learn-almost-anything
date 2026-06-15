# Editing material & sources (load when updating a lesson)

## Updating / editing material

The model owns all content; the MCP just stores it. To change a lesson:

1. `lesson_get({ courseId, lessonId })` to read the current article + widgets.
2. Edit it. When the user asks to change a **specific fragment** ("rewrite the
   part about X", "tighten the intro"):
   - Rewrite ONLY that fragment; preserve the surrounding text verbatim.
   - Keep Markdown formatting and any LaTeX math (`$…$` / `$$…$$`).
   - Don't add new headings, new `::widget` markers, or commentary unless asked.
   - Keep the same language unless asked to translate.
3. Re-`lesson_save` the full updated `article` (and `widgets`/`sources` if changed).
   The node stays `ready`; re-`course_publish` to push the update.

To **deepen / extend** a lesson, append new `## ` sections (edge cases, advanced
techniques, worked examples, pitfalls) without repeating what's already there.

## Sources (be honest)

- `sources` is `[{ "title": "...", "url": "..." }]` — list **only** pages you
  actually consulted while writing or fact-checking the lesson. Do not invent
  URLs or pad with sources you didn't read.
- If you wrote a section purely from your own knowledge with no lookup, don't
  fabricate a citation for it.
- Add the URLs that proved any fact-check corrections (see `fact-checking.md`).
- For **reference formats** (encyclopedia/documentation), end each article with a
  short "See also" / references list and cross-link related articles with
  `[Title](course://article/<Exact Title>)`.
- For a **strict space** course, sources must come only from the space material
  (see `spaces.md`).

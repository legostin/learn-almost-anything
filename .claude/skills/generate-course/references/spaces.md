# Spaces: grounding a course in supplied material (load when a space is given)

A **space** is a closed knowledge base attached to a course: source documents,
allowed links, and local directories, plus a **strict** flag. When the user
builds a course "from these docs / this repo / these sites", that's a space.

Persist it on the course so it survives across sessions and updates:
`course_set_space({ courseId, strict, sources, links, dirs })`. Re-read it any
time via `course_status` (it returns the stored `space`). Then ground **every**
structure decision and lesson in that material.

## Space material

- **dirs** — local directories you may READ with your file tools (list, open,
  grep): a codebase, a folder of notes. Ground lessons in the ACTUAL files; never
  invent file contents.
- **links** — specific URLs (docs sites, repos, pages) you may fetch/read.
- **sources** — documents (`[{ title, kind, path? , content? }]`): read the file
  at `path` with your file tools, or use inline `content`. The excerpt is only a
  hint — read the whole thing.

## Two modes

### strict = true — STRICT SOURCE RULE
The space material is the **only** permitted source.
- Use ONLY this material. Do NOT use your own background knowledge, do NOT invent
  facts/examples/names/numbers/dates/sources, and do NOT do general web research.
- This **overrides** the domain "recommended sources" and any instruction to
  web-search or fact-check against the open web — for a strict course, the space
  IS the ground truth.
- Build the curriculum and write every lesson EXCLUSIVELY from what the material
  contains, at the depth it covers. If the brief asks for something the sources
  don't address, omit it or note it's out of scope — never fill the gap from outside.
- In strict mode, links are the ONLY external URLs you may open.

### strict = false — PRIMARY SOURCES
The space material is the **foundation**, not a cage.
- Form the base of the course and the structure from the space material; it's the
  primary, authoritative source.
- You MAY supplement with your own knowledge and targeted web research to fill
  gaps, add depth or clarify — but the space stays the backbone and you must
  **never contradict it**.
- Favor the space `links` over the open web; apply normal fact-checking
  (`fact-checking.md`) to anything you add from outside.

## Citing

Cite the space material you used (the doc title, the file path, or the link URL)
in `sources`. In strict mode, `sources` must contain only space material.

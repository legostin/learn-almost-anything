# Images: search vs generate (load when illustrating a lesson)

Images are **widgets**: put a marker `::widget{id="img-1"}` on its own line in the
article, and the object under that key in `widgets`. Two kinds of source:

## 1. SEARCH for a real image (default for anything that exists)

Use search for real things: places, people, artworks, products, screenshots,
specimens, historical photos, maps, diagrams that exist in the wild.

1. **Write a tight search query** (your own image/web search): name the specific
   entity (proper name of the place/person/object/work) plus only what
   disambiguates it — city/country, era, or creator. 3–8 words, no quotes / no
   boolean / no `site:` / no "photo"/"image"/"example" padding. Usually the
   local-language proper name is most findable.
2. **Pick a real, direct image URL** — the `url` must point straight at an image
   file (jpg/png/webp), not an HTML page. Prefer images on authoritative/source
   pages (museum, official site, Wikipedia/Commons). If you know the source page,
   open it and take the real asset URL from it.
3. **Minimum size: ≥ 800 px on the long side.** Skip thumbnails and tiny icons.
4. Prefer freely-usable / public-domain / CC media when possible; keep the
   `source` page URL for attribution.

Widget shape:
```json
{ "type": "image", "url": "https://…/thing.jpg", "alt": "<short alt>",
  "description": "<caption shown under the image>", "source": "https://…/page" }
```
Gallery (several related images):
```json
{ "type": "gallery", "caption": "…", "items": [ { "url": "…", "alt": "…", "description": "…", "source": "…" }, … ] }
```

## 2. GENERATE an image (only when no real one fits)

Generate only for things that DON'T exist as a real photo: explanatory
illustrations, abstract concepts, stylized figures. For anything real, SEARCH —
never generate a fake "photo" of a real place/person/work.

- If you have an image-generation tool available, produce the asset and use its
  URL/path. Otherwise prefer a **diagram** widget (Mermaid) for processes,
  architectures and relationships — it's text, always accurate, and needs no search:
```json
{ "type": "diagram", "source": "graph TD; A[Client]-->B[Server];", "caption": "…" }
```

## Don't

- Don't invent image URLs or use `data:` placeholders.
- Don't embed a video you haven't transcript-checked (arts/music/language/lifestyle).
- Don't leave an image widget with an empty/HTML `url` — drop it or make it a diagram.

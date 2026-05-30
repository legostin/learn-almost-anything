import { createServer } from "node:http";
import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC_ORIGIN =
  process.env.PUBLIC_ORIGIN || "https://catalog.almost-anything.io";
const DATA_DIR = path.resolve(process.env.CATALOG_DATA_DIR || "data");
const COURSE_DIR = path.join(DATA_DIR, "courses");
const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_MARK_PATH = path.join(SERVER_DIR, "assets", "app-mark.png");
const UPLOAD_TOKEN = (process.env.CATALOG_UPLOAD_TOKEN || "").trim();
const MAX_UPLOAD_BYTES = positiveNumber(process.env.CATALOG_MAX_UPLOAD_BYTES, 80 * 1024 * 1024);
const WRITE_RATE_LIMIT = positiveNumber(process.env.CATALOG_WRITE_RATE_LIMIT, 30);
const WRITE_RATE_WINDOW_MS = positiveNumber(process.env.CATALOG_WRITE_RATE_WINDOW_MS, 60 * 60 * 1000);
const writeAttempts = new Map();

await mkdir(COURSE_DIR, { recursive: true });

const server = createServer(async (req, res) => {
  try {
    res.headOnly = req.method === "HEAD";
    const method = res.headOnly ? "GET" : req.method;
    const url = new URL(req.url || "/", PUBLIC_ORIGIN);
    if (method === "GET" && url.pathname === "/healthz") {
      return text(res, 200, "ok");
    }
    if (method === "GET" && (url.pathname === "/api/catalog" || url.pathname === "/api/courses")) {
      return json(res, 200, await listCatalog());
    }
    if (method === "GET" && url.pathname === "/assets/app-mark.png") {
      return send(res, 200, await readFile(APP_MARK_PATH), {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=31536000, immutable",
      });
    }
    if (method === "POST" && url.pathname === "/api/courses") {
      return await handleUpload(req, res);
    }

    const apiCourse = url.pathname.match(/^\/api\/courses\/([^/]+)$/);
    if (apiCourse && method === "GET") {
      const id = safeId(decodeURIComponent(apiCourse[1]));
      return json(res, 200, summaryFor(id, await readPackage(id)));
    }
    if (apiCourse && method === "PUT") {
      return await handleUpload(req, res, decodeURIComponent(apiCourse[1]));
    }

    const download = url.pathname.match(/^\/api\/courses\/([^/]+)\/download$/);
    if (method === "GET" && download) {
      const id = safeId(decodeURIComponent(download[1]));
      const raw = await readFile(packagePath(id), "utf8");
      return send(res, 200, raw, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${id}.laacourse.json"`,
      });
    }

    const file = url.pathname.match(/^\/api\/courses\/([^/]+)\/files\/(.+)$/);
    if (method === "GET" && file) {
      return await servePackageFile(res, decodeURIComponent(file[1]), decodeURIComponent(file[2]));
    }

    const course = url.pathname.match(/^\/course\/([^/]+)$/);
    if (method === "GET" && course) {
      const id = safeId(decodeURIComponent(course[1]));
      const pkg = await readPackage(id);
      return html(res, 200, courseHtml(id, pkg));
    }

    if (method === "GET" && url.pathname === "/") {
      return html(res, 200, indexHtml());
    }

    return text(res, 404, "not found");
  } catch (error) {
    console.error(error);
    return text(res, 500, error?.message || "internal error");
  }
});

server.listen(PORT, HOST, () => {
  console.log(`catalog listening on http://${HOST}:${PORT}`);
});

async function handleUpload(req, res, requestedId = "") {
  const rate = checkWriteRate(req);
  if (!rate.ok) return rateLimited(res, rate.retryAfter);
  if (!requireWriteAuth(req, res)) return;

  const body = await readBody(req);
  let pkg;
  try {
    pkg = JSON.parse(body);
  } catch {
    return text(res, 400, "bad json");
  }
  const error = validatePackage(pkg);
  if (error) return text(res, 400, error);

  const id = safeId(requestedId || pkg.course.id || slug(pkg.course.title || pkg.course.topic));
  const version = packageVersion(pkg);
  const existing = await readPackageIfExists(id);
  if (existing && packageVersion(existing) > version) {
    return text(res, 409, "uploaded package is older than the current catalog version");
  }
  await writePackage(id, pkg);
  return json(res, 200, {
    id,
    url: `${PUBLIC_ORIGIN}/course/${encodeURIComponent(id)}`,
    version,
  });
}

async function writePackage(id, pkg) {
  const finalPath = packagePath(id);
  const tmpPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, JSON.stringify(pkg, null, 2));
  await rename(tmpPath, finalPath);
}

function requireWriteAuth(req, res) {
  if (!UPLOAD_TOKEN) {
    return text(res, 503, "catalog publishing is not configured");
  }

  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  if (!secureEqual(token, UPLOAD_TOKEN)) return text(res, 401, "unauthorized");
  return true;
}

function secureEqual(left, right) {
  const leftBytes = Buffer.from(String(left));
  const rightBytes = Buffer.from(String(right));
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function checkWriteRate(req) {
  if (!Number.isFinite(WRITE_RATE_LIMIT) || WRITE_RATE_LIMIT <= 0) return { ok: true };

  const now = Date.now();
  const key = clientIp(req);
  let entry = writeAttempts.get(key);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + WRITE_RATE_WINDOW_MS };
    writeAttempts.set(key, entry);
  }

  entry.count += 1;
  pruneWriteAttempts(now);

  if (entry.count <= WRITE_RATE_LIMIT) return { ok: true };
  return {
    ok: false,
    retryAfter: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
  };
}

function clientIp(req) {
  const realIp = req.headers["x-real-ip"];
  if (typeof realIp === "string" && realIp.trim()) return realIp.trim();

  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }

  return req.socket.remoteAddress || "unknown";
}

function pruneWriteAttempts(now) {
  if (writeAttempts.size < 1000) return;
  for (const [key, entry] of writeAttempts) {
    if (entry.resetAt <= now) writeAttempts.delete(key);
  }
}

function rateLimited(res, retryAfter) {
  send(res, 429, "too many write requests", {
    "Content-Type": "text/plain; charset=utf-8",
    "Retry-After": String(retryAfter),
  });
}

async function servePackageFile(res, rawId, rel) {
  const id = safeId(rawId);
  const pkg = await readPackage(id);
  const normalized = safeRel(rel);
  const file = (pkg.files || []).find((item) => item.path === normalized);
  if (!file) return text(res, 404, "file not found");
  const bytes = Buffer.from(file.base64 || "", "base64");
  return send(res, 200, bytes, {
    "Content-Type": file.media_type || "application/octet-stream",
    "Cache-Control": "public, max-age=31536000, immutable",
  });
}

async function listCatalog() {
  const names = await readdir(COURSE_DIR).catch(() => []);
  const items = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -5);
    try {
      const pkg = JSON.parse(await readFile(path.join(COURSE_DIR, name), "utf8"));
      items.push(summaryFor(id, pkg));
    } catch (error) {
      console.warn(`skip bad package ${name}:`, error.message);
    }
  }
  items.sort((a, b) => b.updated_at - a.updated_at || a.title.localeCompare(b.title));
  return items;
}

async function readPackage(id) {
  return JSON.parse(await readFile(packagePath(safeId(id)), "utf8"));
}

async function readPackageIfExists(id) {
  try {
    return await readPackage(id);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function packagePath(id) {
  return path.join(COURSE_DIR, `${safeId(id)}.json`);
}

function summaryFor(id, pkg) {
  const modules = pkg.structure?.modules || [];
  const lessons = modules.reduce((sum, mod) => sum + (mod.submodules || []).length, 0);
  return {
    id,
    origin_id: pkg.course?.catalog_origin_id || pkg.course?.id || id,
    title: pkg.course?.title || pkg.course?.topic || "Untitled course",
    topic: pkg.course?.topic || "",
    language: pkg.course?.language || "en",
    updated_at: Number(pkg.course?.updated_at || pkg.exported_at || 0),
    version: packageVersion(pkg),
    modules: modules.length,
    lessons,
    generated_lessons: (pkg.submodules || []).length,
    view_url: `${PUBLIC_ORIGIN}/course/${encodeURIComponent(id)}`,
    download_url: `${PUBLIC_ORIGIN}/api/courses/${encodeURIComponent(id)}/download`,
  };
}

function validatePackage(pkg) {
  if (!pkg || typeof pkg !== "object") return "package must be an object";
  if (pkg.schema_version !== 1) return "unsupported package schema";
  if (!pkg.course || typeof pkg.course !== "object") return "missing course";
  if (!pkg.course.topic || !pkg.course.language) return "missing course metadata";
  if (!pkg.structure || !Array.isArray(pkg.structure.modules)) return "missing structure";
  if (!Array.isArray(pkg.submodules) || pkg.submodules.length === 0) {
    return "package has no generated lessons";
  }
  if (!Array.isArray(pkg.files)) return "missing files";
  return "";
}

function packageVersion(pkg) {
  return Number(pkg.course?.catalog_version || pkg.exported_at || pkg.course?.updated_at || 0);
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) {
        req.destroy();
        reject(new Error("upload too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function safeId(value) {
  const id = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  if (!id) throw new Error("bad course id");
  return id;
}

function slug(value) {
  return (
    String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9а-яё]+/giu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 56) || "course"
  );
}

function safeRel(value) {
  const decoded = String(value || "").replace(/\\/g, "/");
  if (!decoded || decoded.startsWith("/") || decoded.includes("..")) {
    throw new Error("bad file path");
  }
  return decoded;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(res.headOnly ? undefined : body);
}

function json(res, status, value) {
  send(res, status, JSON.stringify(value), {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
}

function text(res, status, value) {
  send(res, status, value, { "Content-Type": "text/plain; charset=utf-8" });
}

function html(res, status, value) {
  send(res, status, value, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
}

function baseHead(title) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#1c1917;background:#fafaf9;line-height:1.55;--home-ink:#141414;--home-muted:#6f6b66;--home-rule:#d7d3ce;--home-rule-strong:#1f1f1f;--home-accent:#9b5f32}
*{box-sizing:border-box}body{margin:0;background:#fafaf9}.shell{max-width:1120px;margin:0 auto;padding:28px}
header.catalog-header{position:relative;display:flex;align-items:flex-end;justify-content:space-between;gap:28px;padding-bottom:14px;border-bottom:1px solid var(--home-rule-strong);color:var(--home-ink)}
header.catalog-header::after{content:"";position:absolute;left:0;bottom:-1px;width:88px;height:2px;background:var(--home-accent)}
.catalog-title-block{min-width:0}.catalog-brand-lockup{display:flex;align-items:center;gap:14px;min-width:0}.catalog-brand-logo{width:58px;height:58px;flex:0 0 auto;border-radius:13px;object-fit:cover}.catalog-brand-eyebrow{margin-bottom:3px;color:var(--home-muted);font-size:11px;font-weight:700;letter-spacing:.08em;line-height:1;text-transform:uppercase}.catalog-title-row{display:flex;align-items:center;flex-wrap:wrap;gap:10px;min-width:0}.catalog-title-row h1{min-width:0;margin:0;font-family:Georgia,"Times New Roman",serif;font-size:36px;line-height:1.02;font-weight:700;letter-spacing:0}.catalog-title-button{display:inline;max-width:100%;padding:0;border:0;background:transparent;color:inherit;font:inherit;letter-spacing:0;text-align:left;overflow-wrap:anywhere;cursor:pointer;transition:color 120ms ease}.catalog-title-button:hover{color:var(--home-accent)}.catalog-title-button:focus-visible{outline:2px solid color-mix(in srgb,var(--home-accent) 55%,transparent);outline-offset:3px}.catalog-brand-soft{font-style:italic;font-weight:400}.catalog-title-font-serif{font-family:Georgia,"Times New Roman",serif}.catalog-title-font-humanist{font-family:"Avenir Next",Avenir,Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.catalog-title-font-condensed{font-family:"Arial Narrow","Helvetica Neue",Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-stretch:condensed}.catalog-title-font-mono{font-family:"Courier New",Courier,monospace}.catalog-title-font-display{font-family:Impact,Haettenschweiler,"Arial Black",Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.catalog-title-font-hand{font-family:"Marker Felt","Chalkboard SE","Comic Sans MS",cursive}.catalog-title-weight-400{font-weight:400}.catalog-title-weight-600{font-weight:600}.catalog-title-weight-700{font-weight:700}.catalog-title-weight-800{font-weight:800}.catalog-title-weight-900{font-weight:900}.catalog-title-slant-normal{font-style:normal}.catalog-title-slant-italic{font-style:italic}.catalog-tagline{margin:8px 0 0;max-width:560px;min-height:38px;color:var(--home-muted);font-size:13px;line-height:1.45;text-wrap:balance}.catalog-note{margin:8px 0 0;max-width:560px}.catalog-header .actions{margin-top:12px}
a{color:#8a532d;text-decoration:none}a:hover{text-decoration:underline}.brand{font-weight:800;letter-spacing:-.01em;color:#1c1917}
h1,h2,h3{font-family:Georgia,"Times New Roman",serif;letter-spacing:-.025em;line-height:1.08;margin:0;color:#1c1917}
h1{font-size:clamp(34px,5vw,58px);max-width:860px}.muted{color:#78716c}.note{font-size:13px;color:#78716c}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:0;margin-top:22px;border-top:1px solid #e7e5e4}
.card{padding:18px 0;border-bottom:1px solid #e7e5e4}.card h2{font-size:22px;margin-bottom:8px}.meta{font-size:11px;font-weight:800;color:#a8a29e;letter-spacing:.05em;text-transform:uppercase}
.course-layout{display:grid;grid-template-columns:280px minmax(0,1fr);gap:34px;margin-top:26px}.toc{position:sticky;top:18px;align-self:start;border-right:1px solid #e7e5e4;padding-right:18px;max-height:calc(100vh - 36px);overflow:auto}
.toc button{display:block;width:100%;padding:8px 0;border:0;background:transparent;text-align:left;color:#57534e;cursor:pointer;font:inherit}.toc button.active{color:#8a532d;font-weight:800}
.lesson{max-width:820px}.lesson h2{font-size:36px;margin-bottom:8px}.lead{font-size:18px;color:#57534e;margin:0 0 22px}.reader{font-size:17px}.reader p{margin:0 0 1em}.reader h1,.reader h2,.reader h3{margin:1.4em 0 .55em}.reader pre{overflow:auto;background:#f0efed;padding:12px;border-radius:6px}
figure{margin:26px 0}figure img{display:block;max-width:100%;border-radius:8px;background:#f5f5f4}figcaption{font-size:13px;color:#78716c;margin-top:8px}.gallery{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
.test{margin-top:30px;padding-top:18px;border-top:1px solid #e7e5e4}.test li{margin-bottom:12px}.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:12px}.btn{display:inline-flex;align-items:center;justify-content:center;padding:8px 12px;border-radius:4px;border:1px solid #3f5065;background:#3f5065;color:#fff;font-weight:700}.btn.secondary{background:#fff;color:#1c1917;border-color:#d6d3d1}
@media(max-width:760px){.shell{padding:18px}header.catalog-header{flex-direction:column;align-items:flex-start}.catalog-brand-lockup{align-items:flex-start}.catalog-brand-logo{width:48px;height:48px;border-radius:11px}.catalog-title-row h1{font-size:30px;line-height:1.08}.course-layout{display:block}.toc{position:relative;top:auto;border-right:0;border-bottom:1px solid #e7e5e4;margin-bottom:20px;padding:0 0 14px}.toc button{padding:10px 0}.card{padding:16px 0}}
</style></head><body><div class="shell">`;
}

function indexHtml() {
  return `${baseHead("Learn (Almost) Anything Catalog")}
<header class="catalog-header"><div class="catalog-title-block"><div class="catalog-brand-lockup"><img class="catalog-brand-logo" src="/assets/app-mark.png" alt="" aria-hidden="true"><div><div class="catalog-brand-eyebrow">Catalog</div><div class="catalog-title-row"><h1><button id="catalog-title-button" type="button" class="catalog-title-button" title="Change title font" aria-label="Change title font"><span id="catalog-title-main-a">Learn </span><span id="catalog-title-almost" class="catalog-brand-soft">(Almost)</span><span id="catalog-title-main-b"> Anything</span></button></h1></div></div></div><p class="catalog-tagline">Read-only courses. AI generation and review actions are not available on the web catalog.</p></div></header>
<main><div id="catalog" class="grid"></div></main>
<script>
const root=document.getElementById("catalog");
const titleFonts=["catalog-title-font-serif","catalog-title-font-humanist","catalog-title-font-condensed","catalog-title-font-mono","catalog-title-font-display","catalog-title-font-hand"];
const titleWeights=["catalog-title-weight-400","catalog-title-weight-600","catalog-title-weight-700","catalog-title-weight-800","catalog-title-weight-900"];
const titleSlants=["catalog-title-slant-normal","catalog-title-slant-italic"];
let titleMainClass="",titleAlmostClass="";
function pick(xs){return xs[Math.floor(Math.random()*xs.length)]}
function randomTitleClass(current){let next="";for(let i=0;i<4;i+=1){next=[pick(titleFonts),pick(titleWeights),pick(titleSlants)].join(" ");if(next!==current)break}return next}
function randomizeTitle(){titleMainClass=randomTitleClass(titleMainClass);titleAlmostClass=randomTitleClass(titleAlmostClass);document.getElementById("catalog-title-main-a").className=titleMainClass;document.getElementById("catalog-title-main-b").className=titleMainClass;document.getElementById("catalog-title-almost").className="catalog-brand-soft "+titleAlmostClass}
document.getElementById("catalog-title-button")?.addEventListener("click",randomizeTitle);
fetch("/api/catalog").then(r=>r.json()).then(items=>{
  root.innerHTML=items.length?items.map(item=>\`
    <article class="card">
      <h2><a href="\${item.view_url}">\${esc(item.title)}</a></h2>
      <p class="muted">\${esc(item.topic)}</p>
      <div class="meta">\${esc(item.language)} · \${item.generated_lessons||item.lessons} lessons · \${item.modules} modules</div>
      <div class="actions"><a class="btn" href="\${item.view_url}">Open</a><a class="btn secondary" href="\${item.download_url}">Download</a></div>
    </article>\`).join(""):"<p class='muted'>No published courses yet.</p>";
}).catch(e=>{root.innerHTML="<p class='muted'>Catalog failed to load.</p>"});
function esc(s){return String(s||"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[c]))}
</script></div></body></html>`;
}

function courseHtml(id, pkg) {
  const title = pkg.course?.title || pkg.course?.topic || "Course";
  return `${baseHead(title)}
<header class="catalog-header"><div class="catalog-title-block"><div class="catalog-brand-lockup"><a href="/"><img class="catalog-brand-logo" src="/assets/app-mark.png" alt="Learn (Almost) Anything"></a><div><div class="catalog-brand-eyebrow">Course</div><div class="catalog-title-row"><h1>${escapeHtml(title)}</h1></div></div></div><p class="catalog-tagline">${escapeHtml(pkg.course?.topic || "")}</p><p class="catalog-note note">Read-only web view. AI functionality is available only in the desktop app after downloading.</p><div class="actions"><a class="btn" href="/api/courses/${encodeURIComponent(id)}/download">Download course</a></div></div></header>
<main class="course-layout"><nav id="toc" class="toc"></nav><article id="lesson" class="lesson"></article></main>
<script>window.COURSE_ID=${JSON.stringify(id)};</script>
<script>${courseClientJs()}</script></div></body></html>`;
}

function courseClientJs() {
  return `
const id=window.COURSE_ID;
let pkg=null, lessons=[], active=0;
fetch("/api/courses/"+encodeURIComponent(id)+"/download").then(r=>r.json()).then(data=>{
  pkg=data; lessons=(data.submodules||[]).map(s=>{
    const mod=(data.structure.modules||[]).find(m=>m.id===s.module_id);
    const sub=(mod?.submodules||[]).find(x=>x.id===s.submodule_id);
    return {...s,moduleTitle:mod?.title||"",title:sub?.title||"Lesson",summary:sub?.summary||""};
  });
  renderToc(); renderLesson(0);
});
function renderToc(){
  const toc=document.getElementById("toc");
  toc.innerHTML=lessons.map((l,i)=>\`<button class="\${i===active?"active":""}" onclick="renderLesson(\${i})">\${esc(l.moduleTitle)}<br><strong>\${esc(l.title)}</strong></button>\`).join("");
}
function renderLesson(i){
  active=i; renderToc();
  const l=lessons[i]; if(!l) return;
  document.getElementById("lesson").innerHTML=\`<h2>\${esc(l.title)}</h2>\${l.summary?\`<p class="lead">\${esc(l.summary)}</p>\`:""}<div class="reader">\${renderArticle(l.article,l.widgets||{})}</div>\${renderTest(l.test||[])}\`;
}
function renderArticle(md,widgets){
  const parts=String(md||"").split(/(::widget\\{[^}]+\\})/g);
  return parts.map(part=>{
    const match=part.match(/^::widget\\{[^}]*id="([^"]+)"[^}]*\\}$/);
    if(match) return renderWidget(widgets[match[1]]);
    return renderMarkdown(part);
  }).join("");
}
function renderWidget(w){
  if(!w) return "";
  if(w.type==="image") return imageFigure(w);
  if(w.type==="gallery") return \`<figure><div class="gallery">\${(w.items||[]).map(imageFigure).join("")}</div>\${w.caption?\`<figcaption>\${esc(w.caption)}</figcaption>\`:""}</figure>\`;
  if(w.type==="diagram") return \`<figure><pre>\${esc(w.source||"")}</pre>\${w.caption?\`<figcaption>\${esc(w.caption)}</figcaption>\`:""}</figure>\`;
  if(w.type==="video") return \`<figure><a class="btn secondary" href="\${esc(w.url)}" target="_blank" rel="noreferrer">\${esc(w.title||"Open video")}</a>\${w.why?\`<figcaption>\${esc(w.why)}</figcaption>\`:""}</figure>\`;
  if(w.type==="interactive") return \`<figure><iframe sandbox="allow-scripts" style="width:100%;height:\${Number(w.height)||320}px;border:1px solid #e7e5e4;border-radius:8px;background:white" srcdoc="\${esc(srcdoc(w))}"></iframe><figcaption>\${esc(w.title||"Interactive")}</figcaption></figure>\`;
  return "";
}
function imageFigure(item){
  const src=assetUrl(item.url||"");
  if(!src) return "";
  return \`<figure><img src="\${esc(src)}" alt="\${esc(item.alt||item.description||"")}">\${item.description?\`<figcaption>\${esc(item.description)}</figcaption>\`:""}</figure>\`;
}
function assetUrl(value){
  const prefix="laa://file/";
  if(String(value).startsWith(prefix)) return "/api/courses/"+encodeURIComponent(id)+"/files/"+encodeURIComponent(decodeURIComponent(String(value).slice(prefix.length)));
  return value;
}
function srcdoc(w){return \`<!doctype html><meta charset="utf-8"><style>\${w.css||""}</style>\${w.html||""}<script>\${w.js||""}<\\/script>\`;}
function renderTest(test){
  if(!test.length) return "";
  return \`<section class="test"><h3>Self-check</h3><ol>\${test.map(q=>\`<li><strong>\${esc(q.text)}</strong><ul>\${(q.options||[]).map(o=>\`<li>\${esc(o)}</li>\`).join("")}</ul></li>\`).join("")}</ol></section>\`;
}
function renderMarkdown(md){
  const lines=String(md||"").split(/\\n/); let out="", list=false;
  for(const raw of lines){const line=raw.trimEnd();
    if(!line.trim()){if(list){out+="</ul>";list=false;} continue;}
    const h=line.match(/^(#{1,3})\\s+(.*)$/); if(h){if(list){out+="</ul>";list=false;} out+=\`<h\${h[1].length}>\${inline(h[2])}</h\${h[1].length}>\`; continue;}
    const li=line.match(/^[-*]\\s+(.*)$/); if(li){if(!list){out+="<ul>";list=true;} out+=\`<li>\${inline(li[1])}</li>\`; continue;}
    if(list){out+="</ul>";list=false;} out+=\`<p>\${inline(line)}</p>\`;
  }
  if(list) out+="</ul>"; return out;
}
function inline(s){return esc(s).replace(/\\*\\*([^*]+)\\*\\*/g,"<strong>$1</strong>").replace(/\\[([^\\]]+)\\]\\((https?:[^)]+)\\)/g,'<a href="$2" target="_blank" rel="noreferrer">$1</a>');}
function esc(s){return String(s||"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[c]))}
`;
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char];
  });
}

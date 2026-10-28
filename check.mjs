import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const errors = new Set();
const warnings = [];
const fail = (msg) => errors.add(msg);
const warn = (msg) => warnings.push(msg);

const tracked = new Set(
  execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean)
    .filter((f) => existsSync(join(root, f))),
);
const trackedLower = new Map([...tracked].map((f) => [f.toLowerCase(), f]));

let manifest;
try {
  manifest = JSON.parse(readFileSync(join(root, "reports.json"), "utf8"));
} catch (e) {
  console.error(`FAIL reports.json: ${e.message}`);
  process.exit(1);
}
if (!tracked.has("reports.json")) fail("reports.json is not tracked by git");

const isText = (v) => typeof v === "string" && v.trim() !== "";
const categories = Array.isArray(manifest.categories) ? manifest.categories : [];
const reports = Array.isArray(manifest.reports) ? manifest.reports : [];
const redirects = Array.isArray(manifest.redirects) ? manifest.redirects : [];
if (!Array.isArray(manifest.categories)) fail("reports.json: \"categories\" must be a list");
if (!Array.isArray(manifest.reports)) fail("reports.json: \"reports\" must be a list");
if (manifest.redirects !== undefined && !Array.isArray(manifest.redirects)) fail("reports.json: \"redirects\" must be a list");

const categoryIds = new Set();
categories.forEach((c, i) => {
  if (!isText(c?.id) || !isText(c?.title)) return fail(`reports.json: categories[${i}] needs "id" and "title"`);
  if (categoryIds.has(c.id)) fail(`reports.json: category "${c.id}" is listed twice`);
  categoryIds.add(c.id);
});

const slugs = new Map();
const claimSlug = (slug, where) => {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) fail(`${where}: slug "${slug}" must be lower-case letters, digits and hyphens`);
  if (slugs.has(slug)) fail(`${where}: slug "${slug}" is already used by ${slugs.get(slug)}`);
  slugs.set(slug, where);
};

const usedCategories = new Set();
reports.forEach((r, i) => {
  const where = `reports.json: reports[${i}]${isText(r?.slug) ? ` (${r.slug})` : ""}`;
  for (const field of ["slug", "title", "category", "summary"]) {
    if (!isText(r?.[field])) fail(`${where}: missing "${field}"`);
  }
  if (r?.updated !== undefined) fail(`${where}: remove "updated"; the date comes from the report's newest entry in history.json`);
  if (isText(r?.slug)) claimSlug(r.slug, where);
  if (isText(r?.category)) {
    if (!categoryIds.has(r.category)) fail(`${where}: unknown category "${r.category}"`);
    usedCategories.add(r.category);
  }
  if (isText(r?.summary)) {
    const words = r.summary.trim().split(/\s+/).length;
    if (words > 30) warn(`${where}: summary is ${words} words; keep it to one short sentence`);
  }
});
for (const id of categoryIds) if (!usedCategories.has(id)) warn(`reports.json: category "${id}" has no reports`);

redirects.forEach((r, i) => {
  const where = `reports.json: redirects[${i}]${isText(r?.slug) ? ` (${r.slug})` : ""}`;
  if (!isText(r?.slug) || !isText(r?.to)) return fail(`${where}: needs "slug" and "to"`);
  if (r.title !== undefined && !isText(r.title)) fail(`${where}: "title" must be text when given`);
  claimSlug(r.slug, where);
});

const SITE_FOLDERS = new Set(["history"]);
const folders = readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !SITE_FOLDERS.has(d.name))
  .map((d) => d.name);
for (const folder of folders) {
  if (!slugs.has(folder)) fail(`${folder}/: folder has no entry in reports.json (add it to "reports", or to "redirects" if it is a stub)`);
}
for (const [slug, where] of slugs) {
  if (!folders.includes(slug)) fail(`${where}: no folder "${slug}/"`);
  else if (!tracked.has(`${slug}/index.html`)) fail(`${where}: "${slug}/index.html" is missing or not tracked by git`);
}

const walk = (dir) =>
  readdirSync(join(root, dir), { withFileTypes: true }).flatMap((d) => {
    if (d.name.startsWith(".")) return [];
    const rel = dir ? `${dir}/${d.name}` : d.name;
    return d.isDirectory() ? walk(rel) : [rel];
  });
const pages = walk("").filter((f) => f.endsWith(".html"));

const referenced = new Set();
let refCount = 0;
const SKIP = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;
const MEDIA = /\.(?:png|jpe?g|webp|gif|svg|avif|ico|mp4|webm|mov|mp3|wav|ogg|m4a|flac|json|css|js|html|pdf|txt)$/i;

const resolveRef = (page, raw) => {
  const ref = raw.trim();
  if (!ref || SKIP.test(ref) || ref.includes("${")) return;
  refCount++;
  if (ref.startsWith("/")) return fail(`${page}: "${ref}" is an absolute path; use a relative one`);
  let path = ref.split(/[?#]/)[0];
  try {
    path = decodeURIComponent(path);
  } catch {
    return fail(`${page}: "${ref}" is not a valid URL`);
  }
  let target = posix.normalize(posix.join(posix.dirname(page), path));
  if (target.startsWith("..")) return fail(`${page}: "${ref}" points outside the site`);
  if (path === "" || path.endsWith("/") || target === ".") target = posix.join(target, "index.html");
  else if (!tracked.has(target) && tracked.has(`${target}/index.html`)) target = `${target}/index.html`;
  if (tracked.has(target)) return referenced.add(target);
  const caseMatch = trackedLower.get(target.toLowerCase());
  if (caseMatch) return fail(`${page}: "${ref}" differs in letter case from "${caseMatch}" (GitHub Pages is case-sensitive)`);
  if (existsSync(join(root, target)) && statSync(join(root, target)).isFile()) {
    return fail(`${page}: "${ref}" -> ${target} exists but is not tracked by git (git add it)`);
  }
  fail(`${page}: "${ref}" -> ${target} does not exist`);
};

for (const page of pages) {
  if (!tracked.has(page)) fail(`${page}: page is not tracked by git (git add it)`);
  const html = readFileSync(join(root, page), "utf8").replace(/<!--[\s\S]*?-->/g, "");
  for (const m of html.matchAll(/\s(?:src|href|poster)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) resolveRef(page, m[1] ?? m[2]);
  for (const m of html.matchAll(/\ssrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    for (const part of (m[1] ?? m[2]).split(",")) resolveRef(page, part.trim().split(/\s+/)[0] ?? "");
  }
  for (const m of html.matchAll(/<meta[^>]+http-equiv\s*=\s*["']?refresh[^>]*>/gi)) {
    const url = /url\s*=\s*([^"'>\s]+)/i.exec(m[0]);
    if (url) resolveRef(page, url[1]);
  }
  for (const block of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    for (const m of block[1].matchAll(/["'`]([^"'`\s${}<>]+)["'`]/g)) {
      if (MEDIA.test(m[1]) && !SKIP.test(m[1])) resolveRef(page, m[1]);
    }
  }
}

const BACK = /<a\s[^>]*\bhref\s*=\s*["']\.\.\/(?:index\.html)?["']/i;
for (const page of [...reports.filter((r) => isText(r?.slug)).map((r) => `${r.slug}/index.html`), "history/index.html"]) {
  if (!existsSync(join(root, page))) continue;
  const html = readFileSync(join(root, page), "utf8").replace(/<!--[\s\S]*?-->/g, "");
  if (!BACK.test(html)) fail(`${page}: no link back to the index; add <a class="back" href="../">← All reports</a> at the top of the header`);
}

const isDate = (v) => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};
const now = new Date();
const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
const historySlugs = new Set([...reports, ...redirects].map((r) => r?.slug).filter(isText));
const HISTORY_KEYS = ["date", "author", "slug", "change"];
const entryKey = (e) => JSON.stringify(HISTORY_KEYS.map((k) => e?.[k]));
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const readHistory = (text, label) => {
  const list = JSON.parse(text);
  if (!Array.isArray(list)) throw new Error(`${label} must be a list`);
  return list;
};

let history = [];
if (!tracked.has("history.json")) fail("history.json is missing or not tracked by git");
try {
  history = readHistory(readFileSync(join(root, "history.json"), "utf8"), "history.json");
} catch (e) {
  fail(`history.json: ${e.message}`);
}
const covered = new Set();
history.forEach((e, i) => {
  const where = `history.json: entry ${i}${isText(e?.slug) ? ` (${e.slug})` : ""}`;
  if (!e || typeof e !== "object" || Array.isArray(e)) return fail(`${where}: must be an object`);
  const extra = Object.keys(e).filter((k) => !HISTORY_KEYS.includes(k));
  if (extra.length) fail(`${where}: unknown field(s) ${extra.map((k) => `"${k}"`).join(", ")}`);
  if (!isDate(e.date)) fail(`${where}: "date" must be a real date as YYYY-MM-DD, got ${JSON.stringify(e.date)}`);
  else if (e.date > today) fail(`${where}: "date" ${e.date} is in the future (today is ${today})`);
  if (!isText(e.author)) fail(`${where}: missing "author" (your git config user.name)`);
  if (!isText(e.change)) fail(`${where}: missing "change" (one plain sentence)`);
  if (e.slug === null) return;
  if (!isText(e.slug)) return fail(`${where}: "slug" must be a report slug, or null for a site-wide change`);
  if (!historySlugs.has(e.slug)) return fail(`${where}: unknown slug "${e.slug}"`);
  covered.add(e.slug);
});
for (const r of reports) {
  if (isText(r?.slug) && !covered.has(r.slug)) fail(`reports.json: report "${r.slug}" has no entry in history.json`);
}

const staged = git("diff", "--cached", "--name-only", "-z").split("\0").filter(Boolean);
const stagedSlugs = new Set(staged.map((f) => f.split("/")).filter((p) => p.length > 1 && historySlugs.has(p[0])).map((p) => p[0]));
if (stagedSlugs.size) {
  let before = [];
  let after = [];
  try { before = readHistory(git("show", "HEAD:history.json"), "HEAD:history.json"); } catch {}
  try { after = readHistory(git("show", ":history.json"), "staged history.json"); } catch {}
  const remaining = new Map();
  for (const e of before) remaining.set(entryKey(e), (remaining.get(entryKey(e)) ?? 0) + 1);
  const added = after.filter((e) => {
    const n = remaining.get(entryKey(e)) ?? 0;
    if (n) remaining.set(entryKey(e), n - 1);
    return !n;
  });
  let me = "";
  try { me = git("config", "user.name").trim(); } catch {}
  for (const slug of stagedSlugs) {
    const mine = added.filter((e) => e?.slug === slug);
    if (!mine.length) {
      fail(`${slug}/: files are staged but the staged history.json has no new entry for "${slug}" (add one with today's date, your git user.name and one sentence, then git add history.json)`);
      continue;
    }
    if (me && !mine.some((e) => e.author === me)) {
      warn(`history.json: new entry for "${slug}" is by ${[...new Set(mine.map((e) => `"${e.author}"`))].join(", ")} but git config user.name is "${me}"`);
    }
  }
}

for (const r of redirects) {
  if (!isText(r?.slug) || !isText(r?.to)) continue;
  const stub = `${r.slug}/index.html`;
  if (!existsSync(join(root, stub))) continue;
  const html = readFileSync(join(root, stub), "utf8");
  if (!html.includes(`../${r.to}`)) fail(`${stub}: redirect stub does not link to "../${r.to}"`);
  resolveRef("index.html", r.to);
  const extra = [...tracked].filter((f) => f.startsWith(`${r.slug}/`) && f !== stub);
  if (extra.length) warn(`${r.slug}/: redirect stub folder still holds ${extra.length} file(s): ${extra.join(", ")}`);
}

const unreferenced = new Map();
for (const f of tracked) {
  const top = f.split("/")[0];
  if (!f.includes("/") || !slugs.has(top) || f.endsWith(".html") || referenced.has(f)) continue;
  if (!unreferenced.has(top)) unreferenced.set(top, []);
  unreferenced.get(top).push(f.slice(top.length + 1));
}
for (const [folder, files] of unreferenced) {
  warn(`${folder}/: ${files.length} file(s) not referenced statically (fine if a script builds the path, otherwise delete): ${files.join(", ")}`);
}

console.log(`Checked ${pages.length} pages, ${refCount} references, ${reports.length} reports in ${categoryIds.size} categories, ${redirects.length} redirect(s), ${history.length} history entries${stagedSlugs.size ? ` (staged: ${[...stagedSlugs].join(", ")})` : ""}.`);
for (const w of warnings) console.log(`WARN ${w}`);
for (const e of errors) console.log(`FAIL ${e}`);
if (errors.size) {
  console.log(`${errors.size} error(s). Fix them before pushing.`);
  process.exit(1);
}
console.log(warnings.length ? `OK with ${warnings.length} warning(s).` : "OK.");

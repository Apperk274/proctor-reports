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
  for (const field of ["slug", "title", "category", "updated", "summary"]) {
    if (!isText(r?.[field])) fail(`${where}: missing "${field}"`);
  }
  if (isText(r?.slug)) claimSlug(r.slug, where);
  if (isText(r?.category)) {
    if (!categoryIds.has(r.category)) fail(`${where}: unknown category "${r.category}"`);
    usedCategories.add(r.category);
  }
  if (isText(r?.updated)) {
    const d = new Date(`${r.updated}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.updated) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== r.updated) {
      fail(`${where}: "updated" must be a real date as YYYY-MM-DD, got "${r.updated}"`);
    }
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
  claimSlug(r.slug, where);
});

const folders = readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith("."))
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

console.log(`Checked ${pages.length} pages, ${refCount} references, ${reports.length} reports in ${categoryIds.size} categories, ${redirects.length} redirect(s).`);
for (const w of warnings) console.log(`WARN ${w}`);
for (const e of errors) console.log(`FAIL ${e}`);
if (errors.size) {
  console.log(`${errors.size} error(s). Fix them before pushing.`);
  process.exit(1);
}
console.log(warnings.length ? `OK with ${warnings.length} warning(s).` : "OK.");

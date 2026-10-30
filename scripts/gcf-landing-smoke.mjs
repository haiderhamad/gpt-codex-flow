import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const base = resolve(repo, "docs/gcf-preview");
const file = (path) => readFileSync(resolve(base, path), "utf8");
const site = file("index.html");
const theme = file("theme-light.css");
const architecture = file("architecture-light.svg");
const useCases = file("use-case-flow.svg");
const logo = file("brand-mark.svg");
const notionMemory = file("notion-memory-flow.svg");
const readme = readFileSync(resolve(repo, "README.md"), "utf8");
const packageJson = JSON.parse(readFileSync(resolve(repo, "package.json"), "utf8"));
for (const [readmeText, referenceBase] of [
  [readme, repo]
]) {
for (const match of readmeText.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)) {
  assert.ok(Object.hasOwn(packageJson.scripts, match[1]), `README command is not defined: ${match[1]}`);
}
const localReferences = [
  ...[...readmeText.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)].map(match => match[1]),
  ...[...readmeText.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => match[1])
];
for (const reference of localReferences) {
  if (/^(?:https?:|#)/.test(reference)) continue;
  assert.ok(existsSync(resolve(referenceBase, reference.split("#")[0])), `README relative link does not resolve: ${reference}`);
}
}

assert.equal((site.match(/<section\b/g) || []).length, (site.match(/<\/section>/g) || []).length, "section tags must balance");
for (const asset of ["theme-light.css", "brand-mark.svg", "architecture-light.svg", "use-case-flow.svg", "notion-memory-flow.svg"]) {
  assert.ok(site.includes("./" + asset), `missing site link to ${asset}`);
  assert.ok(existsSync(resolve(base, asset)), `broken local asset ${asset}`);
}
assert.ok(readme.includes("gcf-preview/architecture-overview.gif"), "README must reference the shipped architecture-overview.gif");
for (const svg of [architecture, useCases, notionMemory, logo]) {
  assert.match(svg, /^<svg\b/);
  assert.match(svg.trim(), /<\/svg>$/);
  assert.match(svg, /<title\b/);
  assert.match(svg, /viewBox=/);
}
assert.match(site, /Both assistants can code/, "both clients must remain capable of coding");
for (const name of ["architecture-light.svg"]) {
  const diagram = file(name);
  assert.ok((diagram.match(/Code · [Dd]ebug · [Tt]est · [Pp]lan · [Rr]eview/g) || []).length === 2,
    `${name}: both client labels must include coding, debugging, testing, planning and review`);
  assert.match(diagram, /marker-start="url\(#arrow\)"/, `${name}: show bidirectional handoffs`);
}
assert.match(architecture, /stroke-dashoffset|animation:signal/, "architecture should show motion");
assert.match(useCases, /animation:move/, "use cases should have restrained signal motion");
assert.match(theme, /prefers-reduced-motion/, "respect accessible reduced-motion settings");
for (const svg of [architecture,useCases,notionMemory]) {
  assert.match(svg,/prefers-reduced-motion/,'each external image controls its own motion');
  assert.match(svg,/:root:target/,'a paused SVG fragment must stop animation');
  assert.doesNotMatch(svg,/<script\b|<foreignObject\b|(?:href|src)=["']https?:/i,'SVGs must be self-contained');
}
assert.doesNotMatch(site,/Illustrative workflow · no live connection data|id="motion-toggle"|Pause animation/,'Landing removes the explanatory caption and pause button');
assert.match(site,/syncReducedMotion/,'SVGs must still follow the reduced-motion preference');
assert.ok(existsSync(resolve(base,'architecture-overview.gif')),'README GIF fallback must exist');
assert.match(theme, /--bg:#f3f7fa/, "light slate palette expected");
assert.match(site, /id="use-cases"/);
assert.match(site, /id="orchestration"/);
for (const name of ["ChatGPT Lead","Codex Lead","Auto — Recommend","Transfer Control"]) {
  assert.ok(site.includes(name), `missing orchestration control: ${name}`);
  assert.ok(readme.includes(name), `README missing orchestration control: ${name}`);
}
assert.match(readme, /Auto — Recommend.*advisory choices/);
assert.match(readme, /Transfer Control.*records a handoff/);
assert.match(site, /id="connect"/);

assert.match(site,/id="access-levels"/,"Landing needs a four-level permission comparison");
assert.match(site,/class="access-table"/,"Landing permission matrix must be semantic");
assert.match(theme,/\.access-table tbody tr/,"Landing needs a responsive permission matrix");
for(const title of ["Read Only","Edit Files","Edit &amp; Test","Full Access"]) {
  assert.ok(site.includes(title),"Landing missing access level: "+title);
}
for(const title of ["Read Only","Edit Files","Edit & Test","Full Access"]) {
  assert.ok(readme.includes(title),"README missing access level: "+title);

}
assert.match(readme,/Handoff notes remain writable in every access level/,"README must document handoff exception");
assert.match(readme,/Full Access.*high risk/i,"README must warn about advanced access");
assert.equal((site.match(/data-label="Write Handoff" class="access-yes">Yes/g)||[]).length,4,"Handoff must be writable in all four levels");
assert.match(site,/\.ai-bridge\//,"Landing must explain the scoped Read Only handoff exception");
assert.match(readme,/Handoff notes remain writable in every access level/,"README must separate access from handoff");
assert.match(readme,/ChatGPT's own approval settings do not replace server permissions/,"README must explain independent permission enforcement");
assert.match(site, /id="notion-memory"/, "Landing must describe optional Notion project memory");
assert.match(site, /src="\.\/notion-memory-flow\.svg"/, "Landing must embed the shared animated Notion diagram");
assert.match(readme, /src="docs\/gcf-preview\/notion-memory-flow\.svg"/, "README must embed the same Notion diagram");
assert.match(notionMemory, /ChatGPT and Codex both exchange tasks/, "Diagram must show both clients");
assert.match(notionMemory, /@media\(prefers-reduced-motion:reduce\)/, "Notion diagram must honor reduced motion");
assert.match(notionMemory, /No background sync/, "Diagram must not imply automatic Notion synchronization");
assert.match(notionMemory, /animation:memory-flow/, "Notion connection should animate independently of the main diagram");
assert.match(site, /No automatic background sync/, "Notion memory must not imply automatic synchronization");
assert.match(site, /github\.com\/haiderhamad\/gpt-codex-flow#optional-agent-assisted-notion-project-memory/, "Landing must link to the README Notion setup");
assert.match(readme, /Notion never blocks GCF/, "README must distinguish Notion documentation from core Handoff");
assert.match(site, /id="dashboard"/);
assert.match(site, /screenshots\/control-center-demo\.png/, 'Landing must show current Control Center, not obsolete Admin');
assert.match(readme, /screenshots\/control-center-demo\.png/, 'README must show current Control Center');
assert.ok(existsSync(resolve(base, 'screenshots/control-center-demo.png')), 'Sanitized Control Center capture missing');
assert.match(site, /npm run gcf:ui/, 'Landing must make guided Control Center the default');
assert.doesNotMatch(site,/data-connect=|Local MCP over HTTP|Cloudflare Named Tunnel|ngrok|OpenAI Secure MCP Tunnel/, 'Landing exposes only Cloudflare Quick');
assert.match(site,/Cloudflare Quick Tunnel/, 'Cloudflare Quick is primary connection');
assert.match(site, /navigator\.clipboard\.writeText/, "copy handlers must exist");
const copyIds = [...site.matchAll(/<button[^>]+class="copy"[^>]+data-copy="([^"]+)"/g)].map((m) => m[1]);
assert.ok(copyIds.length >= 4, "expected working setup Copy buttons");
for (const id of copyIds) assert.ok(site.includes(`id="${id}"`), `broken Copy target ${id}`);
assert.match(site, /previous isolated ChatGPT connection succeeded/, "Cloudflare evidence must remain qualified");
assert.match(readme, /Codex.*sandbox|sandbox.*Codex/is, 'README must explain native Codex sandbox boundaries');
assert.doesNotMatch(site, /\bM(?:34|36|37)\b/, "engineering milestone IDs do not belong in marketing copy");
assert.doesNotMatch(theme, /#(?:ff00ff|ff69b4|db00ff)/i, "no loud pink accents");
const adminSource = readFileSync(resolve(repo, "src/gcfControlCenterPage.ts"), "utf8");
// Release claims must not promote future queue, macOS service or browser controls as shipped.
assert.match(readme, /ChatGPT session can continue coding through authorized MCP edit\/test tools/i,
  "README must explicitly support ChatGPT coding after a Codex fallback");
assert.match(readme, /multi(?:ple)?[- ]task.*(?:queue|backlog)|multi-item backlog/i,
  "README must disclose lack of a multi-task queue");
assert.match(readme, /macOS.*(?:autostart|login)|OS login service/i,
  "README must disclose lack of macOS autostart");
assert.match(readme, /Cloudflare Quick Tunnel is the only supported user-facing connection/i,
  "README must state supported Cloudflare connection policy");
assert.match(adminSource, /no agents started|does not start any agents|No agents started|no agent starts/i,
  "Control Center must distinguish UI from worker execution");
assert.match(adminSource, /Full Access risk/,
  "Control Center must display the Full Access risk");


console.log(`GPT Codex Flow static landing checks passed: ${copyIds.length} copy controls; five local assets; responsive light theme; three SVG visuals (including optional Notion memory); qualified connection and security wording.`);

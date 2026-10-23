/** Public source closure: imports, package entrypoints and local documentation links. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const ignored = new Set(['.git', 'node_modules', 'dist', 'output', '.ai-bridge', '.codexbridge']);
function walk(dir) {
  return fs.readdirSync(path.join(root, dir), {withFileTypes: true}).flatMap(entry => {
    if (ignored.has(entry.name) || entry.isSymbolicLink()) return [];
    const relative = path.posix.join(dir, entry.name);
    return entry.isDirectory() ? walk(relative) : [relative];
  });
}
const files = walk('');
const has = relative => fs.existsSync(path.join(root, relative));
const expectFile = (relative, source) => {
  if (!has(relative)) failures.push(`${source}: missing ${relative}`);
};
// tsc does not remove output from deleted source files. Prevent an old local
// build from silently reintroducing retired modules into an npm pack candidate.
for (const entry of fs.readdirSync(path.join(root, 'dist'))) {
  if (entry.endsWith('.js')) expectFile(`src/${entry.slice(0, -3)}.ts`, `dist/${entry}`);
}
let imports = 0;
for (const relative of files.filter(file => /^(src|scripts)\/.*\.(ts|mjs)$/.test(file))) {
  const source = ts.createSourceFile(relative, fs.readFileSync(path.join(root, relative), 'utf8'),
    ts.ScriptTarget.Latest, true, relative.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  function visit(node) {
    let specifier;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
      specifier = node.arguments[0];
    if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith('.')) {
      let target = path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier.text));
      // NodeNext source imports deliberately name the emitted .js module.
      if (relative.endsWith('.ts') && target.endsWith('.js') && has(target.slice(0, -3) + '.ts'))
        target = target.slice(0, -3) + '.ts';
      expectFile(target, relative);
      imports++;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
for (const target of Object.values(pkg.bin)) expectFile(target, 'package.json bin');
for (const target of pkg.files.filter(file => !file.includes('*'))) expectFile(target, 'package.json files');
for (const [name, command] of Object.entries(pkg.scripts)) {
  for (const [, target] of command.matchAll(/\b(?:node|tsx)\s+([^\s;&]+)/g))
    expectFile(target, `npm run ${name}`);
  for (const [, target] of command.matchAll(/\bnpm run\s+([\w:-]+)/g))
    if (!Object.hasOwn(pkg.scripts, target)) failures.push(`npm run ${name}: missing script ${target}`);
}
assert.ok(!Object.keys(pkg.scripts).some(name => /^connect:(?:local|stable|ngrok|setup)$/.test(name)),
  'Only Cloudflare Quick Tunnel is exposed by connection scripts');

const textCache = new Map();
function read(relative) {
  if (!textCache.has(relative)) textCache.set(relative, fs.readFileSync(path.join(root, relative), 'utf8'));
  return textCache.get(relative);
}
function markdownAnchors(text) {
  const anchors = new Set();
  const counts = new Map();
  for (const [, heading] of text.matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)) {
    const slug = heading.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}_\-\s]/gu, '').replace(/\s/g, '-');
    const count = counts.get(slug) || 0;
    anchors.add(slug + (count ? `-${count}` : ''));
    counts.set(slug, count + 1);
  }
  return anchors;
}
let links = 0;
for (const relative of files.filter(file => /\.(md|html|css|svg)$/.test(file) && !file.startsWith('scripts/'))) {
  const content = read(relative).replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '');
  const references = [
    ...[...content.matchAll(/!?\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)].map(match => match[1]),
    ...[...content.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)].map(match => match[1]),
    ...[...content.matchAll(/url\(["']?([^\s)'";]+)["']?\)/g)].map(match => match[1])
  ];
  for (const raw of references) {
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(raw)) continue;
    const reference = raw.replace(/^<|>$/g, '');
    const [targetPath, fragment] = reference.split('#');
    const target = targetPath ? path.posix.normalize(path.posix.join(path.posix.dirname(relative), decodeURIComponent(targetPath.split('?')[0]))) : relative;
    expectFile(target, relative);
    links++;
    if (!has(target) || !fragment || !/\.(md|html|svg)$/.test(target)) continue;
    const text = read(target);
    const anchors = markdownAnchors(text);
    for (const [, id] of text.matchAll(/\b(?:id|name)=["']([^"']+)["']/g)) anchors.add(id);
    if (!anchors.has(decodeURIComponent(fragment))) failures.push(`${relative}: missing anchor ${target}#${fragment}`);
  }
}
assert.deepEqual(failures, [], 'Release source contains broken references');
console.log(`PASS release integrity: ${imports} relative imports; ${links} local documentation/asset links; package scripts, bins and files resolve.`);

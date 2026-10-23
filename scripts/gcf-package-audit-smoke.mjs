import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {auditGcfMetadata,sourceAudit} from './gcf-package-audit.mjs';
const base={name:'@naplesblue/codexbridge',files:['dist','docs','scripts','README.md'],
  bin:{codexbridge:'scripts/codexbridge.mjs'},publishConfig:{access:'public'}};
const x=auditGcfMetadata({pkg:base,readmeHeading:'# CodexBridge',
  inventory:['docs/GCF_NATIVE_SANDBOX_V1_DECISION.md',
    'scripts/gcf-owner-native-role-audit.swift','scripts/gcf-cli.mjs',
    'scripts/.env.secret','docs/guide.md']});
assert.equal(x.status,'RELEASE_BLOCKED');
assert.equal(x.release_approved,false);
for(const code of ['UPSTREAM_PACKAGE_IDENTITY','GCF_CLI_NOT_EXPORTED','UPSTREAM_README',
  'BROAD_PACKAGE_SURFACE','PUBLIC_PUBLISH_CONFIG','SENSITIVE_FILE_NAMES',
  'EXPERIMENTAL_SECURITY_FILES','NPM_PACK_NOT_VERIFIED'])
 assert.ok(x.blockers.some(b=>b.code===code),code);
assert.equal(x.counts.potential_sensitive_names,1);
assert.equal(x.npm_pack_executed,false);
const y=auditGcfMetadata({pkg:{name:'gpt-codex-flow',files:['dist','scripts/gcf-cli.mjs','README.md'],
  bin:{gcf:'scripts/gcf-cli.mjs'}},readmeHeading:'# GPT Codex Flow',inventory:[]});
assert.deepEqual(y.blockers.map(b=>b.code),['NPM_PACK_NOT_VERIFIED']);
const z=await sourceAudit();
assert.equal(z.status,'RELEASE_BLOCKED');
assert.ok(z.counts.candidate_scripts>0);
assert.equal(z.blockers.some(b=>b.code==='UPSTREAM_PACKAGE_IDENTITY'),false,
  'review candidate must have standalone GPT Codex Flow identity');
assert.ok(z.blockers.some(b=>b.code==='NPM_PACK_NOT_VERIFIED'),
  'GitHub-only candidate is not an npm publication approval');
assert.equal(z.writes_performed,false);
// A top-level candidate tree can itself be a symlink. Do not follow it into
// another project while gathering a supposedly bounded source inventory.
const fixture=await fs.mkdtemp(path.join(os.tmpdir(),'gcf-package-audit-'));
try {
  await fs.writeFile(path.join(fixture,'package.json'),JSON.stringify({files:['docs']}));
  await fs.writeFile(path.join(fixture,'README.md'),'# GPT Codex Flow\n');
  await fs.mkdir(path.join(fixture,'outside'));
  await fs.writeFile(path.join(fixture,'outside','private.md'),'not part of package inventory');
  await fs.symlink(path.join(fixture,'outside'),path.join(fixture,'docs'),'dir');
  const linked=await sourceAudit(fixture);
  assert.equal(linked.counts.candidate_docs,0);
  assert.equal(linked.counts.unreadable_or_symlinks,1);
  assert.ok(linked.blockers.some(b=>b.code==='UNSAFE_INVENTORY'));
  await fs.writeFile(path.join(fixture,'package.json'),JSON.stringify({files:['docs/private.md']}));
  const explicitLink=await sourceAudit(fixture);
  assert.equal(explicitLink.counts.candidate_docs,0);
  assert.equal(explicitLink.counts.unreadable_or_symlinks,1);
  await fs.writeFile(path.join(fixture,'package.json'),JSON.stringify({files:['scripts/runtime.mjs']}));
  await fs.mkdir(path.join(fixture,'scripts'));
  await fs.writeFile(path.join(fixture,'scripts/runtime.mjs'),'export const fixture = true;');
  const explicitFile=await sourceAudit(fixture);
  assert.equal(explicitFile.counts.candidate_scripts,1);
  assert.equal(explicitFile.counts.unreadable_or_symlinks,0);
} finally {await fs.rm(fixture,{recursive:true,force:true});}
console.log('PASS: M37 source-only package audit flags identity, broad scripts/docs, experimental/security candidates and actual pack verification gap; no package built/published');

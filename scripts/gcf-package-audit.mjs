#!/usr/bin/env node
/**
 * M37: source-only GCF package exposure audit.
 *
 * This intentionally DOES NOT run npm pack, install, build, publish, shell
 * commands, or inspect the contents of potential credentials. An npm --dry-run
 * from the owner's terminal remains required for the exact shipping file list.
 * A passing audit test must never be interpreted as release authorization.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_ENTRIES=15000;
const isSensitiveName=name=>
  /(^|\/)(?:\.env(?:\.[^/]*)?|\.ai-bridge|\.git|\.gcf|id_rsa|id_ed25519)(?:\/|$)|\.(?:pem|key|p12|pfx|sqlite|db)$/i.test(name);

export function auditGcfMetadata({pkg,readmeHeading,inventory,unreadable=[]}) {
  const reasons=[];
  const add=(code,reason)=>reasons.push({code,reason});
  const files=Array.isArray(pkg?.files)?pkg.files:[];
  const bins=pkg?.bin&&typeof pkg.bin==='object'?pkg.bin:{};
  if (!/^(?:@[^/]+\/)?gpt-codex-flow$/i.test(pkg?.name??''))
    add('UPSTREAM_PACKAGE_IDENTITY','npm package name does not identify a standalone GPT Codex Flow release; owner must decide fork/branding.');
  if (bins.gcf!=='scripts/gcf-cli.mjs')
    add('GCF_CLI_NOT_EXPORTED','Package bin map does not expose the GPT Codex Flow launcher as gcf.');
  // A centered logo may precede the actual H1. Inspect a bounded opening
  // region instead of misclassifying a valid README banner as upstream branding.
  const opening=(readmeHeading??'').split(/\r?\n/).slice(0,8);
  if (!opening.some(line=>/^(?:#\s*GPT Codex Flow(?:\s|$)|<h1(?:\s[^>]*)?>\s*GPT Codex Flow\s*<\/h1>)/i.test(line.trim())))
    add('UPSTREAM_README','Root README does not document GPT Codex Flow as the primary shipped product.');
  if (!files.length)
    add('NO_EXPLICIT_PACKAGE_FILES','No explicit bounded npm files allowlist.');
  if (files.includes('docs') || files.includes('scripts'))
    add('BROAD_PACKAGE_SURFACE','The current npm files allowlist includes whole docs/scripts trees; needs explicit owner review and a narrower standalone distribution manifest.');
  if (pkg?.publishConfig?.access==='public')
    add('PUBLIC_PUBLISH_CONFIG','Existing package declares public npm publication; release requires separate approval.');
  const privateNames=inventory.filter(isSensitiveName);
  if (privateNames.length)
    add('SENSITIVE_FILE_NAMES','Potentially private file names appear within the broad package candidate trees; contents not read.');
  const experiments=inventory.filter(name=>
    name.startsWith('scripts/gcf-owner-native-role-') ||
    /^(?:scripts\/).*-(?:smoke)\.(?:mjs|js)$/.test(name) ||
    name.startsWith('scripts/security-experiment-'));
  if (experiments.length)
    add('EXPERIMENTAL_SECURITY_FILES','Native security research and test fixtures appear in package candidate trees; do not silently distribute as supported runtime.');
  if (unreadable.length)
    add('UNSAFE_INVENTORY','One or more paths cannot be safely inspected or are symlinks.');
  // Static inventory is an intentionally conservative approximation of npm's
  // packlist. A real npm pack --dry-run --json --ignore-scripts is still needed.
  add('NPM_PACK_NOT_VERIFIED','Actual npm pack file list, built dist, archive and isolated install were not independently verified.');
  return {
    status:'RELEASE_BLOCKED',
    audit_kind:'STATIC_SOURCE_INVENTORY_ONLY',
    release_approved:false,
    package_name:pkg?.name??null,
    publish_bin_gcf:bins.gcf??null,
    files_allowlist:files,
    counts:{
      candidate_docs:inventory.filter(n=>n.startsWith('docs/')).length,
      candidate_scripts:inventory.filter(n=>n.startsWith('scripts/')).length,
      potential_sensitive_names:privateNames.length,
      experimental_security_files:experiments.length,
      unreadable_or_symlinks:unreadable.length
    },
    sample_sensitive_names:privateNames.slice(0,8),
    sample_experimental_names:experiments.slice(0,8),
    blockers:reasons,
    writes_performed:false,
    npm_pack_executed:false,
    publish_executed:false
  };
}

async function scan(rootPath,rel,inventory,unreadable) {
  if (inventory.length+unreadable.length>MAX_ENTRIES)
    throw new Error('Package candidate inventory too large; stop for owner review.');
  let entries;
  try{
    const directory=path.join(rootPath,rel);
    const info=await fs.lstat(directory);
    if(info.isSymbolicLink()||!info.isDirectory()) {unreadable.push(rel);return;}
    entries=await fs.readdir(directory,{withFileTypes:true});
  }
  catch{unreadable.push(rel);return;}
  for(const entry of entries) {
    const file=path.posix.join(rel,entry.name);
    if(entry.isSymbolicLink()) {unreadable.push(file);continue;}
    if(entry.isDirectory()) await scan(rootPath,file,inventory,unreadable);
    else if(entry.isFile()) inventory.push(file);
    else unreadable.push(file);
  }
}
export async function sourceAudit(base=root) {
  const pkg=JSON.parse(await fs.readFile(path.join(base,'package.json'),'utf8'));
  const heading=(await fs.readFile(path.join(base,'README.md'),'utf8')).slice(0,4096);
  const files=Array.isArray(pkg.files)?pkg.files:[];
  const inventory=[],unreadable=[];
  for (const dir of ['docs','scripts']) if(files.includes(dir))
    await scan(base,dir,inventory,unreadable);
  // Narrow manifests list individual runtime files. Inspect those too, without
  // following a linked parent directory outside the checkout.
  for (const rel of files.filter(name=>typeof name==='string' &&
      /^(?:docs|scripts)\//.test(name) && !name.includes('*'))) {
    if(rel.split('/').some(part=>!part||part==='.'||part==='..')) {
      unreadable.push(rel); continue;
    }
    let current=base, safe=true;
    for(const part of rel.split('/')) {
      current=path.join(current,part);
      try { if((await fs.lstat(current)).isSymbolicLink()) {safe=false;break;} }
      catch {safe=false;break;}
    }
    if(!safe) {unreadable.push(rel);continue;}
    if(!(await fs.stat(current)).isFile()) {unreadable.push(rel);continue;}
    if(!inventory.includes(rel)) inventory.push(rel);
  }
  return auditGcfMetadata({pkg,readmeHeading:heading,inventory,unreadable});
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(process.argv.length!==2) throw Error('This diagnostic accepts no arguments.');
  const report=await sourceAudit();
  console.log(JSON.stringify(report,null,2));
}

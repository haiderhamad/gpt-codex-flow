#!/usr/bin/env node
/**
 * Read-only public-source snapshot selection PREVIEW for a new independent Git
 * repository. No git add, clone, branch, index edit, copy or publication.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {auditPublicSource} from './gcf-public-source-audit.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const curatedDocs=new Set([
  'docs/GCF_FEATURES_SOURCE_OF_TRUTH.md',
  'docs/GCF_PROJECT_STATUS.md',
  'docs/GCF_PROJECT_HISTORY.md',
  'docs/GCF_NATIVE_SANDBOX_V1_DECISION.md',
  'docs/gcf-role-proof-trust-boundary.md'
]);
function git(args){
  const r=spawnSync('git',['-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null',...args],{
    cwd:root,encoding:null,timeout:25000,maxBuffer:12*1024*1024,shell:false,
    env:{...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_CONFIG_NOSYSTEM:'1'}
  });
  if(r.error||r.status!==0)throw Error('Source candidate inventory unavailable: '+args[0]);
  return r.stdout.toString('utf8').split('\0').filter(Boolean);
}
const selectedByRule=(p)=>{
  // Legacy example is not consumed by runtime/CLI; keep local owner copy private.
  if(p==='config.example.env')return false;
  if(p.startsWith('docs/'))return p.startsWith('docs/gcf-preview/') ||
    curatedDocs.has(p);
  if(p.startsWith('.vscode/'))return false;
  return true; // Existing root configuration, source, scripts, GitHub workflows.
};
function docLinks(content){
  const refs=[
    ...[...content.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)].map(x=>x[1]),
    ...[...content.matchAll(/\b(?:src|href)="([^"]+)"/g)].map(x=>x[1])
  ];
  return refs.filter(ref=>!/^(?:https?:|mailto:|#|data:|\/\/)/i.test(ref));
}
function docsClosure(selected,omitted){
  const missed=[];
  const seen=new Set();
  for(const rel of selected){
    if(!rel.endsWith('.md')&&!rel.endsWith('.html'))continue;
    const source=path.resolve(root,rel);
    const contents=fs.readFileSync(source,'utf8');
    for(const raw of docLinks(contents)){
      const ref=raw.split('#')[0].split('?')[0];
      if(!ref||ref.startsWith('/'))continue;
      const target=path.posix.normalize(path.posix.join(path.posix.dirname(rel),ref));
      if(!omitted.has(target))continue;
      const key=rel+' -> '+target;
      if(seen.has(key))continue;
      seen.add(key);
      missed.push({source:rel,target,reason:'DOCUMENT_LINK_TO_EXCLUDED_FILE'});
    }
  }
  return missed.sort((a,b)=>a.source.localeCompare(b.source)||a.target.localeCompare(b.target));
}
function codeClosure(selected,omitted){
  const missed=[];
  for(const rel of selected){
    if(!rel.startsWith('src/')&&!rel.startsWith('scripts/'))continue;
    if(!/\.(?:mjs|js|ts|py|swift)$/.test(rel))continue;
    const content=fs.readFileSync(path.join(root,rel),'utf8');
    for(const file of omitted){
      if(!file.startsWith('docs/'))continue;
      if(content.includes(file))missed.push({source:rel,target:file,reason:'SOURCE_REFERENCES_EXCLUDED_DOC'});
    }
  }
  return missed.sort((a,b)=>a.source.localeCompare(b.source)||a.target.localeCompare(b.target));
}
export async function sourceCandidatePreview(){
  const tracked=git(['ls-files','--cached','-z']);
  const untracked=git(['ls-files','--others','--exclude-standard','-z']);
  const deleted=new Set(git(['ls-files','--deleted','-z']));
  const available=[...new Set([...tracked,...untracked])].filter(p=>!deleted.has(p)).sort();
  let selected=available.filter(selectedByRule);
  let omitted=available.filter(p=>!selectedByRule(p));
  const initiallyOmitted=omitted.slice();
  const restoredDocumentation=[];
  const publicAudit=await auditPublicSource(root);
  // Keep linked historical evidence rather than shipping broken Markdown links.
  // The closure is read-only: including a path here does not stage or copy it.
  for(let i=0;i<available.length;i++){
    const misses=docsClosure(selected,new Set(omitted));
    if(!misses.length)break;
    const required=[...new Set(misses.map(x=>x.target))].filter(x=>omitted.includes(x));
    if(!required.length)break;
    restoredDocumentation.push(...required);
    const add=new Set(required);
    selected=[...selected,...required].sort();
    omitted=omitted.filter(x=>!add.has(x));
  }
  const omissions=new Set(omitted);
  const docMisses=docsClosure(selected,omissions);
  const codeMisses=codeClosure(selected,omissions);
  const ownerHome=process.env.HOME&&path.resolve(process.env.HOME);
  const ownerHomePathFiles=ownerHome?selected.filter(rel=>/\.(?:md|json|ts|mjs|js)$/.test(rel) &&
    fs.readFileSync(path.join(root,rel),'utf8').includes(ownerHome+'/')):[];
  const sha=crypto.createHash('sha256');
  for(const rel of selected){
    // Hash BOTH relative paths and file bytes. No paths outside Git inventory.
    const bytes=fs.readFileSync(path.join(root,rel));
    sha.update(Buffer.from(rel+'\0','utf8'));
    sha.update(crypto.createHash('sha256').update(bytes).digest());
  }
  return {
    status:publicAudit.status!=='NO_STATIC_FINDINGS'?'SOURCE_AUDIT_BLOCKED':
      (docMisses.length||codeMisses.length)?'REVIEW_DEPENDENCY_GAPS':
      ownerHomePathFiles.length?'REVIEW_MACHINE_LOCAL_PATHS':'READY_FOR_OWNER_SELECTION_REVIEW',
    mode:'READ_ONLY_NO_STAGING_OR_PUBLICATION',
    snapshot_strategy:'Proposed CLEAN independent initial Git commit; existing upstream checkout/history stays unchanged',
    counts:{tracked_entries:tracked.length,untracked_entries:untracked.length,
      previously_deleted_tracked:deleted.size,available:available.length,
      recommended_to_include:selected.length,recommended_to_exclude:omitted.length,
      tracked_paths_to_exclude:omitted.filter(x=>tracked.includes(x)).length,
      doc_link_dependencies_to_excluded:docMisses.length,
      code_dependencies_to_excluded:codeMisses.length,
      initially_omitted:initiallyOmitted.length,
      restored_due_to_doc_links:restoredDocumentation.length,
      owner_home_path_files:ownerHomePathFiles.length},
    selected_sha256:sha.digest('hex'),
    selected_paths:selected,
    excluded_paths:omitted,
    excluded_doc_links:docMisses.slice(0,120),
    excluded_code_references:codeMisses.slice(0,120),
    source_audit_status:publicAudit.status,
    publication_approved:false,git_index_unchanged:true,
    notes:'This is a suggested file set, NOT a staged Git index. Confirm owner approval, review full diff/content and Git history strategy. No old-Mac wipe until fresh verified remote clone and independent private backups.'
  };
}
// Never writes into the checkout or its Git index; selected sources go to a
// randomly named temporary directory, with dependency install scripts disabled.
export async function verifySelectedCandidate({smokeOnly=false}={}){
  const preview=await sourceCandidatePreview();
  if(preview.status!=='READY_FOR_OWNER_SELECTION_REVIEW'){
    return {status:'CANDIDATE_PREFLIGHT_BLOCKED',preflight_status:preview.status,
      selected_count:preview.counts.recommended_to_include};
  }
  const temp=await fs.promises.mkdtemp(path.join(os.tmpdir(),'gcf-selected-snapshot-'));
  const stage=path.join(temp,'standalone-source');
  const selected=preview.selected_paths;
  const MAX_FILES=400,MAX_TOTAL_BYTES=32*1024*1024;
  let total=0,consumed=0;
  const calculateDigest=()=> {
    const digest=crypto.createHash('sha256');
    for(const rel of selected){
      const bytes=fs.readFileSync(path.join(root,rel));
      digest.update(Buffer.from(rel+'\0','utf8'));
      digest.update(crypto.createHash('sha256').update(bytes).digest());
    }
    return digest.digest('hex');
  };
  const report={
    status:'NOT_STARTED',scope:'ONLY_SELECTED_FILES_NO_ORIGINAL_NODE_MODULES',
    selected_count:selected.length,original_source_sha256:preview.selected_sha256,
    copied_sha256:null,copy_verified:false,
    npm_install_strategy:'npm ci --ignore-scripts --no-audit --no-fund --prefer-offline',
    independent_dependency_install:false,borrowed_node_modules:false,
    checks:[],temporary_tree_removed:false,source_unchanged:null,
    existing_git_index_untouched:true,no_commit_or_push:true
  };
  try{
    await fs.promises.mkdir(stage,{recursive:true,mode:0o700});
    const digest=crypto.createHash('sha256');
    for(const rel of selected){
      if(++consumed>MAX_FILES || path.isAbsolute(rel) || rel.split('/').some(s=>!s||s==='.'||s==='..'))
        throw Error('Unsafe or excessive candidate path.');
      let current=root;
      for(const segment of rel.split('/')){
        current=path.join(current,segment);
        const info=await fs.promises.lstat(current);
        if(info.isSymbolicLink())throw Error('Candidate symlink refused.');
      }
      const stat=await fs.promises.stat(current);
      if(!stat.isFile() || stat.size>2*1024*1024)throw Error('Candidate is not an ordinary bounded file.');
      total+=stat.size;
      if(total>MAX_TOTAL_BYTES)throw Error('Candidate byte budget exceeded.');
      const bytes=await fs.promises.readFile(current);
      if(bytes.length!==stat.size)throw Error('Source changed during bounded read.');
      const target=path.join(stage,rel);
      await fs.promises.mkdir(path.dirname(target),{recursive:true});
      await fs.promises.writeFile(target,bytes,{flag:'wx',mode:0o644});
      if(!crypto.createHash('sha256').update(await fs.promises.readFile(target)).digest()
        .equals(crypto.createHash('sha256').update(bytes).digest()))throw Error('Snapshot copy checksum mismatch.');
      digest.update(Buffer.from(rel+'\0','utf8'));
      digest.update(crypto.createHash('sha256').update(bytes).digest());
    }
    report.copied_sha256=digest.digest('hex');
    report.copied_bytes=total;
    if(report.copied_sha256!==preview.selected_sha256)throw Error('Candidate changed after selection.');
    report.copy_verified=true;
    const environment={
      PATH:process.env.PATH||'/usr/bin:/bin',HOME:temp,TMPDIR:temp,
      LANG:'C',LC_ALL:'C',CI:'true',NO_COLOR:'1',
      npm_config_cache:path.join(temp,'npm-cache'),
      npm_config_update_notifier:'false',
      npm_config_ignore_scripts:'true'
    };
    const checks=[
      {label:'npm ci isolated dependency install',args:['ci','--ignore-scripts','--no-audit','--no-fund','--prefer-offline'],timeout:85000},
      {label:'TypeScript build',args:['run','build'],timeout:25000},
      ...(smokeOnly ? [
        {label:'Installed-source launcher and MCP',args:['run','test:gcf-launcher'],timeout:30000},
        {label:'Core task resume without Notion',args:['run','test:gcf-cross-client-resume'],timeout:30000},
        {label:'Release manifest and source closure',args:['run','test:gcf-release-integrity'],timeout:18000}
      ] : [
        {label:'Full GCF core suite',args:['run','test:gcf-core'],timeout:145000},
        {label:'Landing regression',args:['run','test:gcf-landing'],timeout:18000},
        {label:'Admin UI regression',args:['run','test:ui'],timeout:18000},
        {label:'Public PNG screenshot integrity and metadata',args:['run','test:gcf-public-screenshots'],timeout:18000}
      ])
    ];
    for(const check of checks){
      const result=spawnSync('npm',check.args,{cwd:stage,env:environment,
        shell:false,encoding:'utf8',timeout:check.timeout,maxBuffer:3*1024*1024});
      const combined=(result.stderr||'')+'\n'+(result.stdout||'');
      const code=combined.match(/\b(?:ENOTCACHED|ENETUNREACH|EAI_AGAIN|ECONNRESET|EACCES|EPERM|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND)\b/);
      report.checks.push({name:check.label,exit_code:result.status,
        failure_code:result.status===0&&!result.error?null:(result.error?.code||code?.[0]||null),
        passed:result.status===0&&!result.error});
      if(result.status!==0||result.error) {
        report.status=check.args[0]==='ci'?'DEPENDENCY_INSTALL_BLOCKED':'ISOLATED_TEST_FAILED';
        break;
      }
      if(check.args[0]==='ci')report.independent_dependency_install=true;
    }
    if(report.checks.length===checks.length && report.checks.every(x=>x.passed))
      report.status=smokeOnly?'ISOLATED_SELECTED_SOURCE_SMOKE_PASS':'ISOLATED_SELECTED_SOURCE_BUILD_AND_TEST_PASS';
    report.source_unchanged=calculateDigest()===preview.selected_sha256;
    if(!report.source_unchanged)report.status='SOURCE_MUTATED_DURING_ACCEPTANCE';
  }catch(error){report.status='ISOLATED_SNAPSHOT_ABORTED';report.error=error.message;}
  finally{
    await fs.promises.rm(temp,{recursive:true,force:true});
    report.temporary_tree_removed=true;
  }
  return report;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);
  if(args.length>1||args.length===1&&!['--verify','--smoke'].includes(args[0])){
    process.stderr.write('Usage: node scripts/gcf-source-candidate-preview.mjs [--verify|--smoke]\n');
    process.exitCode=2;
  }else{
    const smokeOnly=args[0]==='--smoke';
    const action=args.length?verifySelectedCandidate({smokeOnly}):sourceCandidatePreview();
    action.then(r=>{
      process.stdout.write(JSON.stringify(r,null,2)+'\n');
      if(args.length&&r.status!==(smokeOnly?'ISOLATED_SELECTED_SOURCE_SMOKE_PASS':'ISOLATED_SELECTED_SOURCE_BUILD_AND_TEST_PASS'))process.exitCode=1;
    }).catch(e=>{process.stderr.write('CANDIDATE CHECK FAILED: '+e.message+'\n');process.exitCode=2;});
  }
}

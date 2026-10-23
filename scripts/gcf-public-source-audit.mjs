#!/usr/bin/env node
/**
 * Public Git source candidate audit — READ ONLY.
 *
 * Enumerates tracked + nonignored untracked paths. Does not visit ignored
 * owner data, use a shell, execute model/tool code, print secret values,
 * stage files, commit, or certify Git history / operating-system isolation.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const checkout=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const MAX_FILES=15000;
const MAX_INSPECT_BYTES=2*1024*1024;
// Owner-reviewed, previously tracked historical files removed from the working tree.
// Their removals remain in Git history until a separately approved release commit.
const approvedLegacyDeletions=new Set([
  'AGENTS.example.md','README_ZH.md','FAQ_ZH.md',
  'docs/index.html','docs/zh.html','docs/styles.css','docs/script.js',
  'docs/favicon.svg','docs/star.svg','docs/og.svg'
]);
const safeAsset=/\.(?:png|jpe?g|webp|gif|ico)$/i;
const sensitivePath=/(?:^|\/)(?:\.env(?:\.[^/]*)?|\.ai-bridge|\.codexbridge|\.ssh|\.aws|\.npmrc|\.netrc|id_(?:rsa|ed25519)|credentials(?:\.[^/]*)?|secrets?\.json|.*\.(?:pem|p12|pfx|key|sqlite|db))(?:\/|$)/i;
const isGenerated=/(?:^|\/)(?:node_modules|dist|coverage|output|\.git)(?:\/|$)/;
const patterns=[
  {code:'PRIVATE_KEY_MATERIAL',match:new RegExp('-----BEGIN (?:RSA|OPENSSH|EC|DSA|ENCRYPTED) PRIVATE KEY-----')},
  {code:'GITHUB_TOKEN_PATTERN',match:new RegExp('(?:ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{30,}|github_pat_[a-zA-Z0-9_]{30,}')},
  {code:'SERVICE_TOKEN_PATTERN',match:new RegExp('(?:sk-proj-|sk-live-|xox[baprs]-)[a-zA-Z0-9_-]{20,}')},
  {code:'AWS_ACCESS_KEY_PATTERN',match:new RegExp('(?:AKIA|ASIA)[A-Z0-9]{16}')},
  {code:'CREDENTIAL_URL_PATTERN',match:new RegExp('(?:https?|postgres(?:ql)?):\\/\\/[^\\s/@:]+:[^\\s/@]+@[^\\s/]+')},
];
function git(root,args){
  const r=spawnSync('git',['-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null',...args],{
    cwd:root,encoding:'utf8',shell:false,timeout:25000,maxBuffer:12*1024*1024,
    env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_OPTIONAL_LOCKS:'0'}
  });
  if(r.error||r.status!==0)throw Error('Git source list refused ('+args[0]+').');
  return r.stdout.split('\0').filter(Boolean);
}
async function checkedFile(root,rel){
  let current=root;
  for(const part of rel.split('/')){
    if(!part||part==='.'||part==='..')return {kind:'unsafe'};
    current=path.join(current,part);
    let st;
    try{st=await fs.lstat(current);}catch{return {kind:'missing'};}
    if(st.isSymbolicLink())return {kind:'symlink'};
  }
  const st=await fs.stat(current);
  if(!st.isFile())return {kind:'not-file'};
  if(st.size>MAX_INSPECT_BYTES)return {kind:'oversize',bytes:st.size};
  const data=await fs.readFile(current);
  return {kind:'file',data,bytes:st.size};
}
function localLinks(body){
  const refs=[
    ...[...body.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)].map(m=>m[1]),
    ...[...body.matchAll(/\b(?:src|href)="([^"]+)"/g)].map(m=>m[1])
  ];
  return [...new Set(refs.filter(ref=>!(/^(?:https?:|mailto:|#|data:)/i.test(ref))))];
}
export async function auditPublicSource(root=checkout){
  const tracked=git(root,['ls-files','--cached','-z','--full-name']);
  const untracked=git(root,['ls-files','--others','--exclude-standard','-z','--full-name']);
  const deleted=git(root,['ls-files','--deleted','-z','--full-name']);
  const deletedSet=new Set(deleted);
  const files=[...new Set([...tracked.filter(file=>!deletedSet.has(file)),...untracked])].sort();
  if(files.length>MAX_FILES)throw Error('Public source audit exceeds bounded file count.');
  const findings=[];
  const counts={tracked:tracked.length,untracked:untracked.length,candidate:files.length,
    text:0,approved_public_images:0,manual_binary:0,oversize:0,symlinks:0,
    source:0,tests:0,docs:0,private_paths:0};
  const add=(severity,code,rel)=>findings.push({severity,code,path:rel});
  for(const rel of files){
    if(rel.startsWith('src/'))counts.source++;
    if(rel.startsWith('scripts/'))counts.tests++;
    if(rel.startsWith('docs/'))counts.docs++;
    if(sensitivePath.test(rel)){counts.private_paths++;add('BLOCK','SENSITIVE_PATH',rel);}
    if(isGenerated.test(rel))add('BLOCK','GENERATED_OR_RUNTIME_PATH',rel);
    const f=await checkedFile(root,rel);
    if(f.kind!=='file'){
      if(f.kind==='symlink')counts.symlinks++;
      if(f.kind==='oversize')counts.oversize++;
      add('REVIEW',f.kind.toUpperCase().replaceAll('-','_'),rel);
      continue;
    }
    if(f.data.includes(0)){
      if(safeAsset.test(rel)&&rel.startsWith('docs/gcf-preview/')){
        counts.approved_public_images++;
      }else{
        counts.manual_binary++;
        add('REVIEW','BINARY_REVIEW',rel);
      }
      continue;
    }
    counts.text++;
    const body=f.data.toString('utf8');
    for(const pattern of patterns){
      if(pattern.match.test(body))add('REVIEW',pattern.code,rel);
    }
  }
  const readme=files.includes('README.md');
  if(!readme)add('BLOCK','NO_ROOT_README','README.md');
  else{
    const f=await checkedFile(root,'README.md');
    if(f.kind==='file'){
      const body=f.data.toString('utf8');
      const candidatePaths=new Set(files);
      for(const ref of localLinks(body)){
        const clean=ref.split('#')[0].split('?')[0];
        if(!clean||clean.startsWith('/')||clean.startsWith('../')){
          if(clean)add('REVIEW','README_UNSAFE_REFERENCE',ref);
          continue;
        }
        // A local asset may exist yet be ignored or otherwise absent from a Git clone.
        if(!candidatePaths.has(clean))add('BLOCK','README_NOT_IN_GIT_CANDIDATE',clean);
        const status=await checkedFile(root,clean);
        if(status.kind!=='file'&&status.kind!=='oversize'){
          add('BLOCK','README_BROKEN_REFERENCE',clean);
        }
      }
    }
  }
  const publicFiles=files.filter(x=>x.startsWith('src/')||x.startsWith('scripts/')||
    x.startsWith('docs/gcf-preview/')).length;
  return {
    status:findings.some(x=>x.severity==='BLOCK')?'BLOCKED':findings.length?'REVIEW_REQUIRED':'NO_STATIC_FINDINGS',
    audit_kind:'WORKTREE_TRACKED_PLUS_UNTRACKED_READ_ONLY',
    branch_or_commits_changed:false,git_index_changed:false,publishing_performed:false,
    ignored_private_data_examined:false,git_history_scanned:false,
    privacy_certified:false,source_release_authorized:false,
    counts:{...counts,public_source_runtime_site:publicFiles,findings:findings.length},
    findings:findings.slice(0,140),
    truncated_findings:findings.length>140,
    limitations:'Heuristic path and token pattern scan only; human review required for binary assets, false negatives, embedded secrets, prior Git history, and exact inclusion before staging.'
  };
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.length!==2){process.stderr.write('Usage: node scripts/gcf-public-source-audit.mjs\n');process.exitCode=2;}
  else auditPublicSource().then(report=>process.stdout.write(JSON.stringify(report,null,2)+'\n'))
    .catch(err=>{process.stderr.write('AUDIT REFUSED: '+err.message+'\n');process.exitCode=2;});
}

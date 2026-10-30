#!/usr/bin/env node
/**
 * Construct a disposable clean-root Git INDEX from the exact selected GCF
 * source set. Never touch the original .git, make commits, or use a network.
 * A staged preview in a temporary directory is NOT permission to publish.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {sourceCandidatePreview} from './gcf-source-candidate-preview.mjs';
import {auditPublicSource} from './gcf-public-source-audit.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const MAX_SOURCE_FILES=400, MAX_BYTES=32*1024*1024, MAX_SINGLE=2*1024*1024;
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
function git(cwd,args){
  const r=spawnSync('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args],{
    cwd,encoding:null,timeout:45000,maxBuffer:8*1024*1024,shell:false,
    env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',
      GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0'}
  });
  if(r.error||r.status!==0)throw Error('Git index review refused at step '+args[0]+' (exit '+r.status+').');
  return r.stdout;
}
function pathCheck(rel){
  if(typeof rel!=='string'||path.posix.isAbsolute(rel)||rel.includes('\\')||
    rel.split('/').some(p=>!p||p==='.'||p==='..')||
    path.posix.normalize(rel)!==rel)throw Error('Invalid selected source path.');
}
async function safeBytes(rel){
  pathCheck(rel);
  let current=root;
  for(const part of rel.split('/')){
    current=path.join(current,part);
    const info=await fs.lstat(current);
    if(info.isSymbolicLink())throw Error('Source symlink refused.');
  }
  const st=await fs.stat(current);
  if(!st.isFile()||st.size>MAX_SINGLE)throw Error('Non-regular/oversized selected file.');
  const bytes=await fs.readFile(current);
  if(bytes.length!==st.size)throw Error('Source size changed during staging review.');
  return bytes;
}
const localPaths=/(?:^|\/)(?:\.ai-bridge|\.gcf|\.env(?:\.[^/]*)?|node_modules|dist|output|coverage|\.ssh|\.aws)(?:\/|$)/;
const privatePatterns=[
  ['MACHINE_USER_HOME',/(?:\/Users\/|\/home\/)(?!example\/|user\/|alice\/|yourname\/)[A-Za-z0-9._-]{2,}\//g],
  ['PERSONAL_EMAIL',/\b[a-zA-Z0-9.+_-]+@(?:gmail\.com|yahoo\.[a-z.]+|icloud\.com|outlook\.com|hotmail\.com)\b/gi]
];
export async function reviewStandaloneGitIndex(){
  const preview=await sourceCandidatePreview();
  const out={status:'NOT_STARTED',scope:'DISPOSABLE_INITIAL_COMMIT_INDEX_ONLY',
    source_selection_status:preview.status,
    source_count:preview.counts.recommended_to_include,source_sha256:preview.selected_sha256,
    staged_count:null,staged_paths_exact:false,
    original_index_unchanged:null,original_head_unchanged:null,
    old_history_commits_in_temp:null,git_cached_diff_check:null,
    source_static_scan:null,manual_review_findings:[],reviewed_synthetic_path_hits:0,
    binary_assets:[],staged_git_tree_sha256:null,
    temp_dir_removed:false,original_git_mutated:false,commit_made:false,
    remote_upload_performed:false,owner_publication_approval:false};
  if(preview.status!=='READY_FOR_OWNER_SELECTION_REVIEW'){
    out.status='SOURCE_PREFLIGHT_BLOCKED';return out;
  }
  if(preview.selected_paths.length>MAX_SOURCE_FILES)throw Error('Selected source count exceeds limit.');
  const initialIndex=hash(git(root,['ls-files','--stage','-z']));
  const initialHead=git(root,['rev-parse','HEAD']).toString('utf8').trim();
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'gcf-clean-index-review-'));
  const sandbox=path.join(temp,'source');
  try{
    await fs.mkdir(sandbox,{recursive:true,mode:0o700});
    const fp=crypto.createHash('sha256');
    let total=0;
    const allPaths=new Set(preview.selected_paths);
    for(const rel of preview.selected_paths){
      const bytes=await safeBytes(rel);
      total+=bytes.length;
      if(total>MAX_BYTES)throw Error('Source review cumulative byte limit exceeded.');
      const dest=path.join(sandbox,rel);
      await fs.mkdir(path.dirname(dest),{recursive:true});
      await fs.writeFile(dest,bytes,{flag:'wx',mode:0o644});
      fp.update(Buffer.from(rel+'\0','utf8'));
      fp.update(crypto.createHash('sha256').update(bytes).digest());
      if(localPaths.test(rel))out.manual_review_findings.push({type:'FORBIDDEN_PATH',path:rel});
      if(bytes.includes(0)){
        out.binary_assets.push(rel);
        continue;
      }
      if(/\.(?:md|mjs|ts|js|json|html|css|txt|yml|yaml|env)$/.test(rel)){
        const body=bytes.toString('utf8');
        for(const [type,regex] of privatePatterns){
          regex.lastIndex=0;
          const match=regex.exec(body);
          if(match)out.manual_review_findings.push({type,path:rel,
            line:body.slice(0,match.index).split('\n').length});
        }
      }
    }
    if(fp.digest('hex')!==preview.selected_sha256)throw Error('Selected source changed after inventory.');
    git(sandbox,['init','--initial-branch=main','--quiet']);
    git(sandbox,['add','--all','--']);
    const actual=git(sandbox,['ls-files','-z']).toString('utf8').split('\0').filter(Boolean).sort();
    out.staged_count=actual.length;
    out.staged_paths_exact=actual.length===allPaths.size&&actual.every(p=>allPaths.has(p));
    const extra=actual.filter(p=>!allPaths.has(p));
    const missing=preview.selected_paths.filter(p=>!actual.includes(p));
    if(extra.length||missing.length)out.manual_review_findings.push(
      {type:'STAGING_PATH_MISMATCH',extra_count:extra.length,missing_count:missing.length});
    const cached=spawnSync('git',['-c','core.hooksPath=/dev/null','diff','--cached','--check'],{
      cwd:sandbox,encoding:'utf8',shell:false,timeout:30000,maxBuffer:1024*1024});
    out.git_cached_diff_check=cached.status===0&&!cached.error?'PASS':'REVIEW_REQUIRED';
    out.git_cached_diff_exit_code=cached.status;
    if(cached.status!==0){
      const diagnosticLines=(cached.stdout||'').split('\n').filter(Boolean);
      const paths=diagnosticLines.map(s=>/^(.+?):(\d+): (.+)$/.exec(s))
        .filter(Boolean).map(m=>({path:m[1],line:Number(m[2]),issue:m[3]}));
      out.git_cached_diff_details={issue_count:paths.length,items:paths.slice(0,40),
        stderr_code:(cached.stderr||'').includes('bad revision')?'BAD_REVISION':
          (cached.stderr||'').trim()?'GIT_ERROR':'NONE',
        raw_stdout_lines:diagnosticLines.length};
      out.manual_review_findings.push({type:'INDEX_WHITESPACE_REVIEW',issues:paths.length});
    }
    // A fresh repository without commits/ancestry must contain no reachable commit.
    const history=git(sandbox,['rev-list','--all']).toString('utf8').trim();
    out.old_history_commits_in_temp=history?history.split('\n').length:0;
    const s=await auditPublicSource(sandbox);
    out.source_static_scan=s.status;
    const stagedIndex=git(sandbox,['ls-files','--stage','-z']);
    out.staged_git_tree_sha256=hash(stagedIndex);
    // Exact selected bytes checked after Git staged them.
    const snapshotHash=crypto.createHash('sha256');
    for(const rel of actual){
      const bytes=await fs.readFile(path.join(sandbox,rel));
      snapshotHash.update(Buffer.from(rel+'\0','utf8'));
      snapshotHash.update(crypto.createHash('sha256').update(bytes).digest());
    }
    out.staged_content_sha256=snapshotHash.digest('hex');
    out.staged_content_equals_source=out.staged_content_sha256===preview.selected_sha256;
    out.staged_bytes=total;
    out.status=out.staged_paths_exact&&out.old_history_commits_in_temp===0&&
      out.git_cached_diff_check==='PASS'&&out.source_static_scan==='NO_STATIC_FINDINGS'&&
      out.staged_content_equals_source&&out.manual_review_findings.length===0
      ?'CLEAN_INITIAL_INDEX_REVIEW_PASSED':'OWNER_CONTENT_REVIEW_REQUIRED';
  }catch(e){out.status='INDEX_REVIEW_BLOCKED';out.error=e.message;}
  finally{
    out.original_index_unchanged=hash(git(root,['ls-files','--stage','-z']))===initialIndex;
    out.original_head_unchanged=git(root,['rev-parse','HEAD']).toString('utf8').trim()===initialHead;
    await fs.rm(temp,{recursive:true,force:true});
    out.temp_dir_removed=true;
  }
  if(!out.original_index_unchanged||!out.original_head_unchanged)out.status='ORIGINAL_GIT_STATE_CHANGED';
  return out;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  reviewStandaloneGitIndex().then(r=>{
    process.stdout.write(JSON.stringify(r,null,2)+'\n');
    if(!['CLEAN_INITIAL_INDEX_REVIEW_PASSED','OWNER_CONTENT_REVIEW_REQUIRED'].includes(r.status))
      process.exitCode=1;
  }).catch(e=>{process.stderr.write('GIT STAGING REVIEW ABORTED: '+e.message+'\n');process.exitCode=2;});
}

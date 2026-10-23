#!/usr/bin/env node
/**
 * Explicit owner-run preparation of an independent initial Git source index.
 * PREPARE never commits, pushes, deploys, publishes, or modifies the upstream Git.
 * Refuses pre-existing destination directories and unsafe source entries.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {sourceCandidatePreview} from './gcf-source-candidate-preview.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const digest=x=>crypto.createHash('sha256').update(x).digest('hex');
const MAX_FILES=400, MAX_FILE_BYTES=2*1024*1024, MAX_BYTES=32*1024*1024;
function git(dir,args){
  const proc=spawnSync('git',['-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null',...args],{
    cwd:dir,encoding:null,shell:false,timeout:40000,maxBuffer:8*1024*1024,
    env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0'}
  });
  if(proc.error||proc.status!==0)throw Error('Git verification failed at: '+args[0]);
  return proc.stdout;
}
async function sourceBytes(rel){
  if(!rel || path.posix.isAbsolute(rel) || rel.includes('\\') ||
    rel.split('/').some(p=>!p||p==='.'||p==='..') ||
    path.posix.normalize(rel)!==rel)throw Error('Refusing unsafe candidate path.');
  let current=root;
  for(const segment of rel.split('/')){
    current=path.join(current,segment);
    const st=await fs.lstat(current);
    if(st.isSymbolicLink())throw Error('Refusing symlink source entry.');
  }
  const st=await fs.stat(current);
  if(!st.isFile()||st.size>MAX_FILE_BYTES)throw Error('Refusing nonfile/oversized source entry.');
  const bytes=await fs.readFile(current);
  if(bytes.length!==st.size)throw Error('Source file modified during copy.');
  return bytes;
}
async function fingerprint(paths,dir){
  const h=crypto.createHash('sha256');
  for(const rel of paths){
    const data=await fs.readFile(path.join(dir,rel));
    h.update(Buffer.from(rel+'\0'));
    h.update(Buffer.from(digest(data),'hex'));
  }
  return h.digest('hex');
}
export async function preparePublicSource({destination=null,run=false}={}){
  const selection=await sourceCandidatePreview();
  const report={status:'NOT_PREPARED',operation:run?'CREATE_NEW_LOCAL_INDEX':'READ_ONLY_PREVIEW',
    selected_count:selection.counts.recommended_to_include,
    excluded_count:selection.counts.recommended_to_exclude,
    source_fingerprint:selection.selected_sha256,
    destination:run?destination:null,original_git_modified:false,
    commit_created:false,remote_added:false,push_performed:false,
    npm_published:false,pages_deployed:false};
  if(selection.status!=='READY_FOR_OWNER_SELECTION_REVIEW')
    return {...report,status:'SOURCE_SELECTION_REVIEW_REQUIRED',reason:selection.status};
  if(selection.selected_paths.length>MAX_FILES)throw Error('Candidate file count exceeds safety budget.');
  if(!run)return {...report,status:'READY_FOR_OWNER_PREPARATION',
    note:'Preparation requires --prepare --destination /absolute/new/path. No files were written.'};
  if(typeof destination!=='string'||!path.isAbsolute(destination))
    throw Error('Specify an absolute --destination directory not already present.');
  const resolved=path.resolve(destination);
  if(resolved===root||resolved.startsWith(root+path.sep)||
     root.startsWith(resolved+path.sep)||resolved===path.parse(resolved).root)
    throw Error('Destination cannot overlap the original source checkout.');
  const realParent=await fs.realpath(path.dirname(resolved));
  const realDest=path.join(realParent,path.basename(resolved));
  if(realDest===root||realDest.startsWith(root+path.sep)||root.startsWith(realDest+path.sep))
    throw Error('Resolved destination overlaps original checkout.');
  const beforeIndex=digest(git(root,['ls-files','--stage','-z']));
  const beforeHead=git(root,['rev-parse','HEAD']).toString().trim();
  // Fail when any entry already exists. Never overwrite an owner directory.
  await fs.mkdir(realDest,{recursive:false,mode:0o700});
  report.destination=realDest;
  report.status='NEW_DIRECTORY_CREATED';
  let transferred=0;
  try{
    for(const rel of selection.selected_paths){
      const data=await sourceBytes(rel);
      transferred+=data.length;
      if(transferred>MAX_BYTES)throw Error('Selected source byte budget exceeded.');
      const output=path.join(realDest,rel);
      await fs.mkdir(path.dirname(output),{recursive:true});
      await fs.writeFile(output,data,{flag:'wx',mode:0o644});
    }
    if(await fingerprint(selection.selected_paths,realDest)!==selection.selected_sha256)
      throw Error('Copied source fingerprint mismatch.');
    git(realDest,['init','--quiet','--initial-branch=main']);
    git(realDest,['add','--all','--']);
    const files=git(realDest,['ls-files','-z']).toString().split('\0').filter(Boolean).sort();
    if(files.length!==selection.selected_paths.length ||
       files.some((rel,i)=>rel!==selection.selected_paths[i]))
      throw Error('Staged path selection differs from reviewed source.');
    if(git(realDest,['diff','--cached','--check']).length!==0)
      throw Error('Staged whitespace check failed.');
    if(git(realDest,['rev-list','--all']).length!==0)
      throw Error('New Git repository has unexpected commit history.');
    if(await fingerprint(files,realDest)!==selection.selected_sha256)
      throw Error('Staged file bytes changed.');
    if(digest(git(root,['ls-files','--stage','-z']))!==beforeIndex ||
       git(root,['rev-parse','HEAD']).toString().trim()!==beforeHead)
      throw Error('Original repository changed while preparing source.');
    report.status='LOCAL_CLEAN_GIT_INDEX_PREPARED';
    report.files_staged=files.length;
    report.bytes_copied=transferred;
    report.new_repo_commits=0;
    report.original_git_modified=false;
    report.handoff='Review this new directory; separate explicit owner approval is required for git commit and public push.';
  }catch(error){
    report.status='PREPARATION_INCOMPLETE_REVIEW_NEW_DIRECTORY';
    report.error=error.message;
    // Intentionally do not delete a newly-created directory after a failure:
    // the owner can inspect what was copied without any automatic cleanup.
  }
  return report;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);
  const preview=args.length===1&&args[0]==='--preview';
  const prepare=args.length===3&&args[0]==='--prepare'&&args[1]==='--destination';
  if(!preview&&!prepare){
    process.stderr.write('Usage: node scripts/gcf-public-source-prepare.mjs --preview\n'+
      '   or: node scripts/gcf-public-source-prepare.mjs --prepare --destination /absolute/new/path\n');
    process.exitCode=2;
  }else{
    preparePublicSource({run:prepare,destination:prepare?args[2]:null})
      .then(x=>{process.stdout.write(JSON.stringify(x,null,2)+'\n');
        if(!['READY_FOR_OWNER_PREPARATION','LOCAL_CLEAN_GIT_INDEX_PREPARED'].includes(x.status))
          process.exitCode=1;})
      .catch(error=>{process.stderr.write('PREPARE ABORTED: '+error.message+'\n');process.exitCode=2;});
  }
}

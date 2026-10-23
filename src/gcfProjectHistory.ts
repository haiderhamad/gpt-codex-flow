/** Optional owner-local project history bootstrap. Never overwrites user documentation. */
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const CANDIDATES=['docs/PROJECT_HISTORY.md','PROJECT_HISTORY.md','docs/GCF_PROJECT_HISTORY.md','HISTORY.md','docs/HISTORY.md'] as const;

function ordinaryFile(file:string):boolean {
  const s=fs.lstatSync(file,{throwIfNoEntry:false});
  return Boolean(s?.isFile() && !s.isSymbolicLink() && s.nlink===1);
}

/** Identifies existing history without opening secrets or following links. */
export function projectHistoryPath(root:string):string|null {
  for(const relative of CANDIDATES) {
    const filename=path.join(root,relative);
    if(ordinaryFile(filename)) return relative;
  }
  return null;
}

export function freshProjectFolder(root:string):boolean {
  return fs.readdirSync(root).every(name=>['.git','.DS_Store','.gitignore'].includes(name));
}

/** Only call after explicit owner-local folder approval, never from a public MCP route. */
export function initializeProjectHistory(root:string):{state:'created'|'existing';path:string} {
  const existing=projectHistoryPath(root);
  if(existing) return {state:'existing',path:existing};
  const docs=path.join(root,'docs');
  const prior=fs.lstatSync(docs,{throwIfNoEntry:false});
  if(prior && (!prior.isDirectory()||prior.isSymbolicLink())) throw Error('History folder is not an ordinary directory.');
  if(!prior) fs.mkdirSync(docs,{mode:0o755});
  const target=path.join(docs,'PROJECT_HISTORY.md');
  // No following or replacing an existing file, even if it appeared after discovery.
  if(fs.lstatSync(target,{throwIfNoEntry:false})) {
    if(ordinaryFile(target)) return {state:'existing',path:'docs/PROJECT_HISTORY.md'};
    throw Error('Project history destination is unsafe.');
  }
  const today=new Date().toISOString().slice(0,10);
  const name=path.basename(root).replace(/[\r\n#]/g,' ').slice(0,100);
  const text=`# ${name} — Project History

## Quick Summary
- **Project:** ${name}
- **Stage:** Initialized in GPT Codex Flow
- **Goal and technology:** Not specified yet
- **Last documented:** ${today}
- **Next:** Define project purpose and first verified milestone

## Key Decisions
- ${today}: Began a concise shared project history. No architecture decisions recorded yet.

## Verified Milestones
- Project history initialized locally with owner approval; no build or application tests implied.

## Open Items
- Define project goals and initial requirements.

<!-- Update only after meaningful, verifiable milestones or decisions.
     Keep the Quick Summary under 250 words. No transcripts or secrets. -->
`;
  const tmp=path.join(docs,'.project-history-'+randomUUID()+'.tmp');
  try {
    const fd=fs.openSync(tmp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|(fs.constants.O_NOFOLLOW??0),0o600);
    try{fs.writeFileSync(fd,text);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    // Link is intentionally not used: linkSync is exclusive, unlike renameSync.
    fs.linkSync(tmp,target);
  } finally {try{fs.unlinkSync(tmp);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
  return {state:'created',path:'docs/PROJECT_HISTORY.md'};
}

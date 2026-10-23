// Owner-controlled native Codex executable pin. No executable or model is launched.
// Pin before terminal consent, verify afterwards and again immediately before spawn.
// Hash/device/inode checks narrow TOCTOU but do NOT prove code-signing or containment.
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import {constants as fsConstants} from 'node:fs';
import path from 'node:path';

const MAX_EXECUTABLE_BYTES=512*1024*1024;
const FIELDS=['candidate','realpath','sha256','size','dev','ino',
  'mode','mtimeNs','candidateKind','linkTarget'];
const metadata=stat=>({
  size:Number(stat.size),dev:stat.dev.toString(),ino:stat.ino.toString(),
  mode:stat.mode.toString(),mtimeNs:stat.mtimeNs.toString()
});
async function fingerprint(candidate,maxBytes) {
  if(typeof candidate!=='string'||!path.isAbsolute(candidate))
    throw new Error('Native Codex executable requires an absolute path.');
  const link=await fs.lstat(candidate,{bigint:true});
  const candidateKind=link.isSymbolicLink()?'symlink':link.isFile()?'file':'unsupported';
  if(candidateKind==='unsupported')throw new Error('Native executable candidate is not a file/symlink.');
  const linkTarget=candidateKind==='symlink'?await fs.readlink(candidate):null;
  const realpath=await fs.realpath(candidate);
  const initial=await fs.lstat(realpath,{bigint:true});
  if(!initial.isFile()||initial.isSymbolicLink()||initial.size<1n||
      initial.size>BigInt(maxBytes))
    throw new Error('Native executable is not a bounded regular file.');
  await fs.access(candidate,fsConstants.X_OK);
  const handle=await fs.open(realpath,fsConstants.O_RDONLY|(fsConstants.O_NOFOLLOW??0));
  let digest;
  try {
    const opened=await handle.stat({bigint:true});
    if(!opened.isFile()||opened.dev!==initial.dev||opened.ino!==initial.ino||
       opened.size!==initial.size||opened.mtimeNs!==initial.mtimeNs||
       opened.mode!==initial.mode)
      throw new Error('Executable changed between discovery and open.');
    const hash=createHash('sha256'),chunk=Buffer.allocUnsafe(64*1024);
    let total=0;
    for(;;) {
      const {bytesRead}=await handle.read(chunk,0,chunk.length,null);
      if(!bytesRead)break;
      total+=bytesRead;
      if(total>maxBytes)throw new Error('Executable exceeded size limit during read.');
      hash.update(chunk.subarray(0,bytesRead));
    }
    const final=await handle.stat({bigint:true});
    if(total!==Number(opened.size)||final.dev!==opened.dev||final.ino!==opened.ino||
       final.size!==opened.size||final.mtimeNs!==opened.mtimeNs||
       final.mode!==opened.mode)
      throw new Error('Executable changed during hash calculation.');
    digest=hash.digest('hex');
  }finally{await handle.close();}
  const endLink=await fs.lstat(candidate,{bigint:true});
  const endReal=await fs.realpath(candidate);
  if(endReal!==realpath||endLink.dev!==link.dev||endLink.ino!==link.ino||
     endLink.mtimeNs!==link.mtimeNs||
     (candidateKind==='symlink'&&await fs.readlink(candidate)!==linkTarget))
    throw new Error('Executable candidate/link changed during pin.');
  return Object.freeze({candidate,realpath,sha256:digest,...metadata(initial),
    candidateKind,linkTarget});
}
export async function pinNativeCodexExecutable({
  searchPath=process.env.PATH??'',maxBytes=MAX_EXECUTABLE_BYTES
}={}) {
  if(typeof searchPath!=='string'||!Number.isSafeInteger(maxBytes)||
     maxBytes<1||maxBytes>MAX_EXECUTABLE_BYTES)
    throw new Error('Invalid Codex PATH or executable size limit.');
  for(const dir of searchPath.split(path.delimiter)){
    if(!path.isAbsolute(dir))continue;
    const candidate=path.join(dir,'codex');
    try{return await fingerprint(candidate,maxBytes);}
    catch(error) {
      if(['ENOENT','EACCES','ENOTDIR'].includes(error?.code))continue;
      throw error;
    }
  }
  throw new Error('No readable native Codex executable found.');
}
export async function verifyPinnedNativeCodexExecutable(pinned,{
  maxBytes=MAX_EXECUTABLE_BYTES
}={}) {
  if(!pinned||typeof pinned!=='object'||FIELDS.some(k=>!Object.hasOwn(pinned,k)))
    throw new Error('Native Codex executable pin missing or malformed.');
  const current=await fingerprint(pinned.candidate,maxBytes);
  if(FIELDS.some(k=>pinned[k]!==current[k]))
    throw new Error('Pinned Native Codex executable changed after owner review; no execution.');
  return current.realpath;
}

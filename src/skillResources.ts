/**
 * Read-only bounded text resources INSIDE an already discovered Skill package.
 * Does not execute scripts, decode binary assets, or read arbitrary home paths.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {createHash} from "node:crypto";
import {TextDecoder} from "node:util";
import type {Workspace} from "./guard.js";
import {resolveSkillFile, type SkillInventoryItem} from "./capabilitiesOps.js";

const MAX_FILE_BYTES=2_000_000;
const MAX_LIST_ITEMS=300;
const MAX_SCAN_ENTRIES=2_000;
const MAX_DEPTH=5;
const ROOTS=new Set(["references","resources","scripts","data","assets","templates"]);
const TEXT_EXT=new Set([
  ".md",".txt",".csv",".tsv",".json",".jsonl",".yaml",".yml",".toml",
  ".py",".js",".mjs",".cjs",".ts",".tsx",".jsx",".sh",".css",".html",".xml",
  ".svg",".sql",".ini",".conf"
]);
const SENSITIVE=/(?:^|[-_.])(secret|password|credentials?|privatekey|api[_-]?key|token)(?:[-_.]|$)/i;
const decoder=new TextDecoder("utf-8",{fatal:true});
// Node v26 on macOS does not expose this Darwin flag in fs.constants.  Its
// value is defined by Darwin's <sys/fcntl.h>.  Passing a numeric flag to
// fs.open is supported by Node; Darwin rejects every symlink in the complete
// pathname when this flag is present (not merely the final component).
const DARWIN_O_NOFOLLOW_ANY=0x20000000;
type SkillSelection={name:string;source?:SkillInventoryItem["source"];path?:string;includeGlobal?:boolean};
interface ResourceMeta {path:string;bytes:number}

function components(relative:string):string[]{
  if(typeof relative!=="string" || relative.length<3 || relative.length>350 ||
    relative.startsWith("/") || relative.includes("\\") || relative.includes("\0")) {
    throw new Error("Skill resource path must be a relative POSIX path.");
  }
  const parts=relative.split("/");
  if(parts.length<2 || parts.length>8 || !ROOTS.has(parts[0]) ||
    parts.some(v=>!v||v==="."||v===".."||v.startsWith(".")||SENSITIVE.test(v))) {
    throw new Error("Skill resource path is outside approved package content directories.");
  }
  const ext=path.extname(parts.at(-1)!).toLowerCase();
  if(!TEXT_EXT.has(ext))throw new Error("Only bounded textual Skill resources may be read.");
  return parts;
}
function within(child:string,parent:string):boolean {
  return child.startsWith(parent+path.sep);
}
async function approvedBase(workspace:Workspace,select:SkillSelection){
  const found=await resolveSkillFile(workspace,select);
  const folder=path.dirname(found.absPath);
  const stats=await fsp.lstat(folder);
  if(!stats.isDirectory()||stats.isSymbolicLink())throw new Error("Unsafe Skill folder.");
  const canonical=await fsp.realpath(folder);
  return {skill:found.skill,folder,canonical};
}
/** Avoid following symlinked directories (even if they resolve inside the Skill). */
async function approveResource(
  folder:string,canonical:string,parts:string[]
):Promise<{absolute:string;stat:fs.Stats}>{
  let current=folder;
  for(let i=0;i<parts.length;i++){
    current=path.join(current,parts[i]);
    const stat=await fsp.lstat(current);
    if(stat.isSymbolicLink())throw new Error("Skill resource symlinks are not allowed.");
    if(i<parts.length-1&&!stat.isDirectory())
      throw new Error("Skill resource parent must be a directory.");
    if(i===parts.length-1&&(!stat.isFile()||stat.nlink!==1||stat.size>MAX_FILE_BYTES))
      throw new Error("Skill resource must be a single-link bounded regular file.");
  }
  const real=await fsp.realpath(current);
  if(!within(real,canonical))throw new Error("Skill resource escaped package root.");
  return {absolute:current,stat:await fsp.lstat(current)};
}

/**
 * Open the final resource through Darwin's kernel-enforced whole-path
 * no-symlink check.  O_NOFOLLOW only protects the leaf; O_NOFOLLOW_ANY is
 * required to close an intermediate-directory replacement race.  On an
 * unsupported OS/kernel this fails closed instead of falling back to a
 * best-effort realpath/lstat check.
 */
async function openResourceNoSymlinks(absolute:string):Promise<fs.promises.FileHandle>{
  if(process.platform!=="darwin")
    throw new Error("Secure Skill resource access requires macOS whole-path no-follow support.");
  try{
    // O_NOFOLLOW_ANY already includes leaf protection.  Darwin rejects the
    // otherwise-redundant O_NOFOLLOW combination with EINVAL on this host.
    return await fsp.open(absolute,fs.constants.O_RDONLY|DARWIN_O_NOFOLLOW_ANY);
  }catch(error){
    if((error as NodeJS.ErrnoException).code==="EINVAL")
      throw new Error("Secure Skill resource access is unavailable: this macOS/Node runtime does not accept whole-path no-follow.");
    throw error;
  }
}

async function readSliceBounded(handle:fs.promises.FileHandle,totalBytes:number,
  offset:number,cap:number):Promise<Buffer>{
  // One extra UTF-8 character can occupy at most three continuation bytes.
  // This fixed allocation is the only file-content buffer in this operation.
  const bytesToRead=Math.min(totalBytes-offset,cap+3);
  const buffer=Buffer.alloc(bytesToRead);
  const {bytesRead}=await handle.read(buffer,0,buffer.length,offset);
  return buffer.subarray(0,bytesRead);
}

export async function listSkillResources(workspace:Workspace,select:SkillSelection,
  opts:{offset?:number;limit?:number}={}) {
  const {skill,folder,canonical}=await approvedBase(workspace,select);
  const all:ResourceMeta[]=[];
  let capped=false;
  let entriesExamined=0;
  const walk=async(current:string,prefix:string,depth:number):Promise<void>=>{
    if(capped || depth>MAX_DEPTH)return;
    const directory=await fsp.opendir(current,{bufferSize:32});
    try{
      for await(const entry of directory){
        if(entriesExamined>=MAX_SCAN_ENTRIES||all.length>=MAX_LIST_ITEMS){capped=true;return;}
        entriesExamined++;
        if(entry.name.startsWith(".") || SENSITIVE.test(entry.name)||
            entry.isSymbolicLink())continue;
        const rel=prefix+"/"+entry.name;
        const child=path.join(current,entry.name);
        if(entry.isDirectory()){
          if(depth<MAX_DEPTH)await walk(child,rel,depth+1);
          continue;
        }
        if(!entry.isFile()||!TEXT_EXT.has(path.extname(entry.name).toLowerCase()))continue;
        try{
          components(rel);
          const checked=await approveResource(folder,canonical,rel.split("/"));
          if(checked.stat.size<=MAX_FILE_BYTES)
            all.push({path:rel,bytes:checked.stat.size});
        }catch{
          // Never include links/hardlinks/oversized/unsafe resources in catalog.
        }
      }
    }finally{
      await directory.close().catch(()=>undefined);
    }
  };
  for(const root of ROOTS){
    const abs=path.join(folder,root);
    try{
      const st=await fsp.lstat(abs);
      if(!st.isDirectory()||st.isSymbolicLink())continue;
      await walk(abs,root,1);
    }catch(error){
      if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;
    }
    if(capped)break;
  }
  all.sort((a,b)=>a.path.localeCompare(b.path));
  const offset=Math.max(0,Math.min(Math.floor(opts.offset??0),100000));
  const limit=Math.max(1,Math.min(Math.floor(opts.limit??30),50));
  const results=all.slice(offset,offset+limit);
  return {skill,resources:results,count:results.length,total_found:all.length,
    scan_limit_reached:capped,offset,next_offset:offset+results.length<all.length
      ?offset+results.length:null,
    entries_examined:entriesExamined,scan_entry_limit:MAX_SCAN_ENTRIES,
    read_only:true,binary_assets_supported:false,auto_execution:false};
}
export async function readSkillResource(workspace:Workspace,select:SkillSelection,
  requested:{resource_path:string;offset_bytes?:number;max_bytes?:number}) {
  const parts=components(requested.resource_path);
  const {skill,folder,canonical}=await approvedBase(workspace,select);
  const resolved=await approveResource(folder,canonical,parts);
  const handle=await openResourceNoSymlinks(resolved.absolute);
  try{
    const st=await handle.stat();
    if(!st.isFile()||st.nlink!==1||st.dev!==resolved.stat.dev||
      st.ino!==resolved.stat.ino||st.size>MAX_FILE_BYTES)
      throw new Error("Skill resource changed during file open or exceeds size cap.");
    const offset=requested.offset_bytes??0;
    if(!Number.isSafeInteger(offset)||offset<0||offset>=Math.max(st.size,1))
      throw new Error("Invalid skill resource byte offset.");
    const cap=Math.max(1000,Math.min(requested.max_bytes??40_000,100_000));
    const buffer=await readSliceBounded(handle,st.size,offset,cap);
    const after=await handle.stat();
    if(after.size!==st.size||after.mtimeMs!==st.mtimeMs||
       after.ctimeMs!==st.ctimeMs||after.dev!==st.dev||after.ino!==st.ino)
      throw new Error("Skill resource changed while reading.");
    if(offset>0&&(buffer[0]&0xc0)===0x80)
      throw new Error("Offset must begin at a UTF-8 character boundary.");
    let bytes=Math.min(buffer.length,cap);
    while(bytes>0&&bytes<buffer.length&&(buffer[bytes]&0xc0)===0x80)bytes--;
    if(bytes<=0&&st.size>offset)throw new Error("Invalid UTF-8 slice boundary.");
    const chunk=buffer.subarray(0,bytes);
    const end=offset+chunk.length;
    const text=decoder.decode(chunk);
    return {
      skill,resource_path:requested.resource_path,text,
      offset_bytes:offset,bytes:chunk.length,total_bytes:st.size,
      next_offset:end<st.size?end:null,complete:offset===0&&end===st.size,
      truncated:end<st.size,
      chunk_sha256:createHash("sha256").update(chunk).digest("hex"),
      read_only:true,script_executed:false
    };
  }finally{
    await handle.close();
  }
}

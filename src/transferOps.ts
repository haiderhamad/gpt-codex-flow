import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { GcfConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { GcfError, PathGuard } from "./guard.js";
import { readActiveTask } from "./taskStore.js";
export type Lead = "chatgpt_lead" | "codex_lead";
export interface Transfer {
  id: string; task_id: string; from: Lead; to: Lead;
  state: "requested" | "accepted" | "cancelled";
  created_at: string; expires_at: string; git_head: string; git_status_sha256: string;
  handoff: { goal: string; plan: string[]; target_paths: string[] };
}
const rel = (c: GcfConfig) => c.contextDir + "/transfer-control.json";
function git(w: Workspace, args: string[]) {
  const p = spawnSync("git", args, { cwd:w.root, encoding:"utf8", timeout:5000, maxBuffer:500000 });
  if (p.status !== 0 || p.error) throw new GcfError("Git state could not be verified.");
  return p.stdout;
}
async function snapshot(w: Workspace) {
  const head = git(w, ["rev-parse", "HEAD"]).trim();
  const status = git(w, ["status", "--porcelain=v1", "--untracked-files=all"]);
  // Hash tracked working-tree changes AND untracked content, not only filenames.
  // Otherwise an untracked file can be modified without changing porcelain status.
  const trackedDiff = git(w, ["diff", "--binary", "HEAD", "--"]);
  const names = git(w, ["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0").filter(Boolean);
  if (names.length > 5000) throw new GcfError("Too many untracked files for transfer baseline.");
  const digest = createHash("sha256");
  digest.update(status).update("\0").update(trackedDiff).update("\0");
  for (const name of names.sort()) {
    const absolute = path.resolve(w.root, name);
    if (!absolute.startsWith(w.root + path.sep))
      throw new GcfError("Unsafe untracked path.");
    const stat = await fs.lstat(absolute);
    digest.update(name).update("\0").update(String(stat.mode)).update("\0");
    if (stat.isSymbolicLink()) {
      digest.update(await fs.readlink(absolute));
    } else if (stat.isFile()) {
      for await (const chunk of createReadStream(absolute)) digest.update(chunk);
    } else {
      throw new GcfError("Unrecognized untracked file type.");
    }
    digest.update("\0");
  }
  // Only a one-way digest is recorded, never file content or sensitive filenames.
  return { head, status_sha256: digest.digest("hex") };
}
function active(c:GcfConfig,g:PathGuard,w:Workspace,id:string) {
  const task=readActiveTask(c,g,w);
  if(!task || task.status!=="in_progress" || task.task_id!==id) throw new GcfError("Matching active task required.");
  return task;
}
async function read(c:GcfConfig,g:PathGuard,w:Workspace):Promise<Transfer|null> {
  const file=g.resolve(w,rel(c)).absPath;
  let data:string;try{data=await fs.readFile(file,"utf8");}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return null;throw e;}
  if(data.length>30000)throw new GcfError("Transfer state too large.");
  let t:Transfer;try{t=JSON.parse(data);}catch{throw new GcfError("Corrupt transfer state.");}
  if (!t || !["requested","accepted","cancelled"].includes(t.state) ||
      !t.id?.startsWith("transfer_") || !t.task_id?.startsWith("task_") ||
      !["chatgpt_lead","codex_lead"].includes(t.from) ||
      !["chatgpt_lead","codex_lead"].includes(t.to) || t.from === t.to ||
      typeof t.git_head !== "string" || !/^[a-f0-9]{64}$/.test(t.git_status_sha256) ||
      !t.handoff || typeof t.handoff.goal !== "string" ||
      !Array.isArray(t.handoff.plan) || !Array.isArray(t.handoff.target_paths))
    throw new GcfError("Unrecognized transfer state.");
  return t;
}
async function mutate(c:GcfConfig,g:PathGuard,w:Workspace,action:(current:Transfer|null)=>Promise<Transfer>):Promise<Transfer> {
  const file=g.resolve(w,rel(c),{forWrite:true}).absPath;
  await fs.mkdir(path.dirname(file),{recursive:true});
  const lock=file+".lock";
  let handle:fs.FileHandle;
  try{handle=await fs.open(lock,"wx",0o600);}catch(e){if((e as NodeJS.ErrnoException).code==="EEXIST")throw new GcfError("Transfer locked; inspect before retrying.");throw e;}
  try{
    const updated=await action(await read(c,g,w));
    const temp=file+"."+randomUUID()+".tmp";
    try{await fs.writeFile(temp,JSON.stringify(updated,null,2)+"\n",{flag:"wx",mode:0o600});await fs.rename(temp,file);}
    finally{await fs.rm(temp,{force:true});}
    return updated;
  }finally{await handle.close();await fs.rm(lock,{force:true});}
}
export async function transferStatus(c:GcfConfig,g:PathGuard,w:Workspace) {
  const record=await read(c,g,w);
  const task=readActiveTask(c,g,w);
  return {transfer:record, active_task_id:task?.status==="in_progress"?task.task_id:null,
    ownership_enforced:false, client_identity_verified:false};
}
export async function requestTransfer(c:GcfConfig,g:PathGuard,w:Workspace,
  a:{task_id:string;from:Lead;to:Lead;user_confirmed:boolean}):Promise<Transfer> {
  if(!a.user_confirmed)throw new GcfError("Explicit confirmation required.");
  if(!["chatgpt_lead","codex_lead"].includes(a.from)||!["chatgpt_lead","codex_lead"].includes(a.to)||a.from===a.to)
    throw new GcfError("Invalid transfer direction.");
  return mutate(c,g,w,async previous=>{
    const task=active(c,g,w,a.task_id);
    const gitState=await snapshot(w);
    if(previous?.task_id===task.task_id) {
      if(previous.state==="requested" && Date.now()<Date.parse(previous.expires_at)){
        if(previous.from===a.from && previous.to===a.to && previous.git_head===gitState.head && previous.git_status_sha256===gitState.status_sha256) return previous;
        throw new GcfError("Pending transfer conflicts.");
      }
      if((previous.state==="accepted"?previous.to:previous.from)!==a.from)throw new GcfError("Recorded owner mismatch.");
    }
    return {id:"transfer_"+randomUUID(),task_id:task.task_id,from:a.from,to:a.to,
      state:"requested",created_at:new Date().toISOString(),expires_at:new Date(Date.now()+900000).toISOString(),
      git_head:gitState.head,git_status_sha256:gitState.status_sha256,
      handoff:{goal:task.goal.slice(0,1000),plan:task.plan_steps.slice(0,25).map(step=>step.slice(0,300)),target_paths:task.target_paths.slice(0,25).map(p=>p.slice(0,180))}};
  });
}
export async function acceptTransfer(c:GcfConfig,g:PathGuard,w:Workspace,
  a:{transfer_id:string;recipient:Lead;user_confirmed:boolean}):Promise<Transfer> {
  if(!a.user_confirmed)throw new GcfError("Explicit confirmation required.");
  return mutate(c,g,w,async t=>{
    if(!t||t.id!==a.transfer_id ||t.to!==a.recipient)throw new GcfError("Transfer or recipient mismatch.");
    if (t.state !== "requested" && t.state !== "accepted") throw new GcfError("Transfer not pending.");
    if (t.state === "requested" && Date.now() >= Date.parse(t.expires_at))
      throw new GcfError("Transfer expired.");
    active(c,g,w,t.task_id);
    const current=await snapshot(w);
    if(current.head!==t.git_head || current.status_sha256!==t.git_status_sha256)throw new GcfError("Stale Git baseline; request fresh transfer.");
    if (t.state === "accepted") return t; // Replayed only after task and Git baseline checks.
    return {...t,state:"accepted"};
  });
}
export async function cancelTransfer(c:GcfConfig,g:PathGuard,w:Workspace,
  a:{transfer_id:string;user_confirmed:boolean}):Promise<Transfer> {
  if(!a.user_confirmed)throw new GcfError("Explicit confirmation required.");
  return mutate(c,g,w,async t=>{
    if(!t||t.id!==a.transfer_id)throw new GcfError("Transfer not found.");
    if(t.state==="cancelled")return t;
    if(t.state!=="requested")throw new GcfError("Only pending transfers can be cancelled.");
    return {...t,state:"cancelled"};
  });
}

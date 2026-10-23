/** Durable, advisory, project-scoped human handoff inbox.
 * File-based only; never runs models or grants ownership/authorization.
 * Role names and "user_confirmed" are claims, not authenticated identities.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { CodexBridgeConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { CodexBridgeError, PathGuard } from "./guard.js";
import { readActiveTask } from "./taskStore.js";
import { assertInboxGitPrivacy } from "./inboxGitPrivacy.js";

export type InboxRole = "chatgpt_lead" | "codex_lead";
export interface TaskInboxItem {
  schema_version: 1;
  id: string;
  task_id: string;
  in_reply_to?: string;
  from: InboxRole;
  to: InboxRole;
  title: string;
  request: string;
  created_at: string;
  state: "pending";
}
const maxEntries = 40;
const maxFileBytes = 6500;
const maxTitleChars = 120;
const maxRequestChars = 2400;
const validId = /^inbox_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const nameOf = (id: string) => id + ".json";
const directoryRel = (c: CodexBridgeConfig) => c.contextDir + "/task-inbox";

function assertId(id: string): void {
  if (!validId.test(id)) throw new CodexBridgeError("Invalid inbox message ID.");
}
function assertRole(role: string): asserts role is InboxRole {
  if (role !== "codex_lead" && role !== "chatgpt_lead") throw new CodexBridgeError("Invalid inbox role.");
}
function dir(c: CodexBridgeConfig, guard: PathGuard, workspace: Workspace, create: boolean): string {
  const abs = guard.resolve(workspace, directoryRel(c), {forWrite:create}).absPath;
  try {
    const st = fs.lstatSync(abs);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new CodexBridgeError("Unsafe inbox directory.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (!create) return abs;
    fs.mkdirSync(abs, { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(abs);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new CodexBridgeError("Unsafe inbox directory.");
  }
  return abs;
}
function ensureMessage(value: unknown, expectedId: string): TaskInboxItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CodexBridgeError("Corrupt inbox item.");
  const v = value as Partial<TaskInboxItem>;
  if (v.schema_version !== 1 || v.id !== expectedId ||
      typeof v.task_id !== "string" || !/^task_[0-9a-f-]{8,80}$/.test(v.task_id) ||
      typeof v.from !== "string" || typeof v.to !== "string" ||
      !["codex_lead","chatgpt_lead"].includes(v.from) ||
      !["codex_lead","chatgpt_lead"].includes(v.to) || v.from === v.to ||
      v.state !== "pending" ||
      (v.in_reply_to !== undefined &&
        (typeof v.in_reply_to !== "string" || !validId.test(v.in_reply_to) || v.in_reply_to===expectedId)) ||
      typeof v.title !== "string" || !v.title.trim() || v.title.length > maxTitleChars ||
      typeof v.request !== "string" || !v.request.trim() || v.request.length > maxRequestChars ||
      typeof v.created_at !== "string" || !Number.isFinite(Date.parse(v.created_at))) {
    throw new CodexBridgeError("Corrupt inbox item.");
  }
  return v as TaskInboxItem;
}
async function readFile(c: CodexBridgeConfig, guard: PathGuard, w: Workspace, id: string): Promise<TaskInboxItem> {
  assertId(id);
  const file = guard.resolve(w, directoryRel(c)+"/"+nameOf(id)).absPath;
  const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(file, flags);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new CodexBridgeError("Inbox item not found.");
    throw error;
  }
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.nlink !== 1 || st.size > maxFileBytes) throw new CodexBridgeError("Unsafe or oversized inbox item.");
    return ensureMessage(JSON.parse(await handle.readFile("utf8")),id);
  } catch (error) {
    if (error instanceof SyntaxError) throw new CodexBridgeError("Corrupt inbox JSON.");
    throw error;
  } finally {
    await handle.close();
  }
}
async function existingIds(c:CodexBridgeConfig,g:PathGuard,w:Workspace):Promise<string[]> {
  const directory=dir(c,g,w,false);
  let names:string[];
  try{names=await fsp.readdir(directory);}catch(e){
    if((e as NodeJS.ErrnoException).code==="ENOENT")return [];
    throw e;
  }
  if(names.length>maxEntries+1)throw new CodexBridgeError("Inbox at capacity; owner review required.");
  for(const name of names) {
    if(name===".post.lock")continue;
    if(!name.endsWith(".json") || !validId.test(name.slice(0,-5))) {
      throw new CodexBridgeError("Unexpected inbox entry; owner review required.");
    }
  }
  return names.filter(name=>name!==".post.lock").map(name=>name.slice(0,-5)).sort();
}
export async function listTaskInbox(c:CodexBridgeConfig,g:PathGuard,w:Workspace,
  filters:{to?:InboxRole;task_id?:string}={}) {
  if(filters.to!==undefined)assertRole(filters.to);
  if(filters.task_id!==undefined && !/^task_[0-9a-f-]{8,80}$/.test(filters.task_id))
    throw new CodexBridgeError("Invalid inbox task filter.");
  const ids=await existingIds(c,g,w);
  const all=await Promise.all(ids.map(id=>readFile(c,g,w,id)));
  // Role filters are convenience only; they never grant authenticated role ACLs.
  const entries=all.filter(item=>
    (filters.to===undefined || item.to===filters.to) &&
    (filters.task_id===undefined || item.task_id===filters.task_id));
  entries.sort((a,b)=>b.created_at.localeCompare(a.created_at)||a.id.localeCompare(b.id));
  return {count:entries.length,total_count:all.length,
    entries:entries.map(({id,task_id,in_reply_to,from,to,title,created_at,state})=>({
      id,task_id,...(in_reply_to?{in_reply_to}:{}),from,to,title,created_at,state
    })),advisory_only:true,client_identity_verified:false,auto_execution:false,
    recipient_filter_is_not_authorization:true};
}
export async function readTaskInbox(c:CodexBridgeConfig,g:PathGuard,w:Workspace,id:string) {
  return {message:await readFile(c,g,w,id),advisory_only:true,client_identity_verified:false,auto_execution:false};
}
export async function postTaskInbox(c:CodexBridgeConfig,g:PathGuard,w:Workspace,a:{
  task_id:string;from:InboxRole;to:InboxRole;title:string;request:string;in_reply_to?:string;user_confirmed:boolean;
}) {
  if (c.writeMode==="off") throw new CodexBridgeError("Inbox post requires handoff write permission.");
  if (a.user_confirmed!==true) throw new CodexBridgeError("Explicit user confirmation required to share an inbox note.");
  assertRole(a.from);assertRole(a.to);
  if(a.from===a.to)throw new CodexBridgeError("Inbox recipient must differ from sender.");
  const title=a.title?.trim(),request=a.request?.trim();
  if(!title || title.length>maxTitleChars || title.includes("\0") ||
     !request || request.length>maxRequestChars || request.includes("\0")) {
    throw new CodexBridgeError("Inbox title or request is missing, unsafe, or too long.");
  }
  // Never write task context into a Git-tracked/includable directory.
  // Reading an existing inbox is still permitted if this fails.
  assertInboxGitPrivacy(w.root);
  const task=readActiveTask(c,g,w);
  if(!task || task.status!=="in_progress" || task.task_id!==a.task_id)
    throw new CodexBridgeError("Matching active project task required.");
  const directory=dir(c,g,w,true);
  const lock=path.join(directory,".post.lock");
  let handle:fsp.FileHandle;
  try{handle=await fsp.open(lock,"wx",0o600);}catch(e){
    if((e as NodeJS.ErrnoException).code==="EEXIST")
      throw new CodexBridgeError("Inbox post is already in progress; retry after inspection.");
    throw e;
  }
  try{
    if((await existingIds(c,g,w)).length>=maxEntries)throw new CodexBridgeError("Inbox at capacity; owner review required.");
    if(a.in_reply_to!==undefined){
      assertId(a.in_reply_to);
      const parent=await readFile(c,g,w,a.in_reply_to);
      if(parent.task_id!==task.task_id || parent.from!==a.to || parent.to!==a.from){
        throw new CodexBridgeError("Reply must reference a note in this task addressed to the claimed sender.");
      }
    }
    // Recheck active task while holding the post lock: it may change between
    // initial validation and the serialized write phase (advisory, not a CAS).
    const latest=readActiveTask(c,g,w);
    if(!latest || latest.status!=="in_progress" || latest.task_id!==task.task_id)
      throw new CodexBridgeError("Active task changed before inbox post.");
    const message:TaskInboxItem={schema_version:1,id:"inbox_"+randomUUID(),task_id:task.task_id,
      ...(a.in_reply_to?{in_reply_to:a.in_reply_to}:{}),
      from:a.from,to:a.to,title,request,created_at:new Date().toISOString(),state:"pending"};
    const target=g.resolve(w,directoryRel(c)+"/"+nameOf(message.id),{forWrite:true}).absPath;
    const tmp=target+"."+randomUUID()+".tmp";
    try{
      await fsp.writeFile(tmp,JSON.stringify(message)+"\n",{flag:"wx",mode:0o600});
      await fsp.rename(tmp,target);
    }finally{
      await fsp.rm(tmp,{force:true});
    }
    return {message,advisory_only:true,client_identity_verified:false,auto_execution:false};
  }finally{
    await handle.close();
    await fsp.rm(lock,{force:true});
  }
}

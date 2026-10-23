/** GCF Task Inbox Git disclosure guard.
 * Refuse to CREATE private note content when the repository would accidentally
 * include the .ai-bridge metadata in normal Git commits.
 * This is a Git hygiene check, NOT a sandbox or a defense against git add -f.
 */
import { spawnSync } from "node:child_process";
import { CodexBridgeError } from "./guard.js";

export interface InboxGitPrivacyAudit {
  safe_to_post: boolean;
  inbox_ignored: boolean;
  tracked_bridge_paths: number;
  warning: string | null;
}

function runGit(root: string, args: string[]): { status: number; stdout: string } {
  const result=spawnSync("git",[
    "-c","core.fsmonitor=false","-C",root,...args
  ],{
    encoding:"utf8",shell:false,timeout:5000,maxBuffer:65536,
    env:{...process.env,GIT_OPTIONAL_LOCKS:"0",GIT_TERMINAL_PROMPT:"0"}
  });
  if(result.error || result.signal || result.status===null ||
    (result.status!==0 && result.status!==1)) {
    throw new CodexBridgeError(
      "Cannot verify private Task Inbox Git status; refusing a metadata write."
    );
  }
  return {status:result.status,stdout:result.stdout||""};
}

/** No Git or source changes. Run at time of posting rather than once during setup. */
export function auditInboxGitPrivacy(root: string): InboxGitPrivacyAudit {
  // An ordinary folder outside any repository cannot be accidentally committed
  // by Git. A folder nested in a parent repository still needs the full audit.
  const probe = spawnSync("git",["-c","core.fsmonitor=false","-C",root,
    "rev-parse","--show-toplevel"],{encoding:"utf8",shell:false,timeout:5000,maxBuffer:65536,
    env:{...process.env,GIT_OPTIONAL_LOCKS:"0",GIT_TERMINAL_PROMPT:"0"}});
  if (probe.error || probe.signal || probe.status === null) {
    throw new CodexBridgeError("Cannot verify Task Inbox Git privacy; refusing a metadata write.");
  }
  if (probe.status !== 0) {
    if (probe.status === 128 && /not a git repository/i.test(probe.stderr ?? "")) {
      return {safe_to_post:true,inbox_ignored:false,tracked_bridge_paths:0,warning:null};
    }
    throw new CodexBridgeError("Cannot verify Task Inbox Git privacy; refusing a metadata write.");
  }
  // --no-index discovers ignored patterns even if a malicious client has staged
  // one of the .ai-bridge files; separate ls-files detects that tracking.
  const ignored=runGit(root,[
    "check-ignore","--no-index","--quiet","--",
    ".ai-bridge/task-inbox/gcf-private-note-probe.json"
  ]).status===0;
  const tracked=runGit(root,["ls-files","--cached","-z","--",".ai-bridge"]);
  if(tracked.status!==0){
    throw new CodexBridgeError(
      "Cannot inspect tracked .ai-bridge Git files; refusing a metadata write."
    );
  }
  const trackedCount=tracked.stdout.split("\0").filter(Boolean).length;
  const safe=ignored&&trackedCount===0;
  const warning=safe?null:
    !ignored&&trackedCount
      ?"The .ai-bridge/task-inbox/ path is not ignored and .ai-bridge/ contains tracked files."
      :!ignored
        ?"The .ai-bridge/task-inbox/ path is not ignored by Git."
        :"The .ai-bridge/ directory contains tracked files despite ignore rules.";
  return {
    safe_to_post:safe,inbox_ignored:ignored,
    tracked_bridge_paths:trackedCount,warning
  };
}

export function assertInboxGitPrivacy(root: string): void {
  const result=auditInboxGitPrivacy(root);
  if(!result.safe_to_post){
    throw new CodexBridgeError(
      "Task Inbox post blocked to prevent accidental Git disclosure. "+
      result.warning+
      " The repository owner must review Git ignore/tracked state first;"+
      " GCF never changes .gitignore or Git index automatically."
    );
  }
}

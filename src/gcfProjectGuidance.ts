/** A per-repository ChatGPT Project Instructions template; no client settings are modified. */
import path from 'node:path';
export function chatgptProjectInstructions(root:string):string {
  const name=path.basename(root);
  const text=`This ChatGPT Project covers the approved repository "${name}" at "${root}".

Start via GPT Codex Flow MCP: list_projects and select_project for the exact approved root/ID. Read lead_preference or get_project_orchestrator_mode(workspace_id); Lead is advisory, never permission. Never silently switch projects.

Before substantial work, read AGENTS.md and applicable nested instructions. If AGENTS.md points to NOTION_MEMORY.md, read it. Also check whether NOTION_MEMORY.md exists even without a pointer; follow it when enabled or use the owner-pasted Notion block in AGENTS.md. These rules survive GCF disconnect when local files remain accessible.

Always use shared_project_state, task_resume and relevant Task Inbox for GCF handoffs; never gate them on Notion. Notion disabled: skip it silently. Only if opted in, use this client's authorized official Notion plugin/MCP for durable decisions/milestones after deduplication. If unavailable, report NOTION_SYNC_PENDING but continue GCF normally. Never mirror handoffs.

Read README.md and docs/PROJECT_HISTORY.md when present; verify Git/code/tests. Load only relevant .codex/ and .agents/ Skills/profiles with approved tools; instructions do not start agents. Preserve unrelated edits and secrets. No push, deployment or access elevation without owner approval.`;
  if(text.length>1500) throw Error('Project instructions exceeded the 1,500-character target.');
  return text;
}

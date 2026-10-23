/** A per-repository ChatGPT Project Instructions template; no client settings are modified. */
import path from 'node:path';
export function chatgptProjectInstructions(root:string):string {
  const name=path.basename(root);
  const text=`This ChatGPT Project is dedicated to the local repository "${name}" at "${root}".

At the start of repository work, use the authorized GPT Codex Flow MCP connection. List projects and select the exact matching root/ID. Never silently switch projects.

Before editing, read applicable repository AGENTS.md / AGENTS.override.md (including nested instructions for files you touch) and available global Codex AGENTS.md if securely exposed. Discover only task-relevant approved Skills (SKILL.md) and agent profiles; loading a profile does not run an agent.

Read shared_project_state and project_summary to resume the existing task/handoff. Read the short docs/PROJECT_HISTORY.md or other existing project history and README as needed. Treat Git, source and test results as proof; saved plans are not proof of completion.

After verified meaningful decisions/milestones, update the existing project history concisely if authorized. Do not record transcripts/secrets. Preserve unrelated changes. If MCP, rules, history or permissions are unavailable, say so. Never commit, push, deploy or elevate privileges without owner approval.`;
  if(text.length>1500) throw Error('Project instructions exceeded the 1,500-character target.');
  return text;
}

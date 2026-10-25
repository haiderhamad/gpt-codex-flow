/** A per-repository ChatGPT Project Instructions template; no client settings are modified. */
import path from 'node:path';
export function chatgptProjectInstructions(root:string):string {
  const name=path.basename(root);
  const text=`This ChatGPT Project covers the approved repository "${name}" at "${root}".

At the start of a task, connect through GPT Codex Flow MCP, list projects and select this exact approved root/ID. Never guess or switch roots silently.

Before coding, read applicable AGENTS.md (including nested rules), README.md and docs/PROJECT_HISTORY.md if present. Read shared_project_state/project_summary for recorded work, but verify source, Git and tests.

Discover task-relevant Agent profiles in .codex/agents/*.toml or *.md and Skills in .codex/skills/ or .agents/skills/ (or approved global locations). Use search_agent_profiles/search_skills and load only selected profile instructions/SKILL.md with approved tools. Repository rules take precedence. Never load the entire catalog, execute bundled scripts by default or assume a loaded profile runs an agent. Delegate only if supported and authorized.

Report which profiles and Skills were consulted, and which were inaccessible; distinguish consulted profiles from executed agents. Preserve unrelated changes, never store secrets, and do not push, deploy or elevate access without owner approval.`;
  if(text.length>1500) throw Error('Project instructions exceeded the 1,500-character target.');
  return text;
}

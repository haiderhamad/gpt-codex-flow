// Read-only, deterministic user-facing project lookup.
// Not authentication, authorization, or a ChatGPT conversation identity.
export type ProjectLookupEntry = {
  project_id: string;
  name: string;
  root: string;
  directory_name: string;
  alias_source: "local-registry" | "directory";
};
export type ProjectLookupResult = {
  status: "unique" | "ambiguous" | "not_found";
  requested_name: string;
  matches: ProjectLookupEntry[];
  next_action: "select_project" | "ask_user" | "list_projects";
};

function normalized(value: string): string {
  return value.normalize("NFC").trim().toLocaleLowerCase("en-US");
}

export function findProjectByExactName(
  requestedName: string,
  projects: readonly ProjectLookupEntry[]
): ProjectLookupResult {
  // No fuzzy or substring matching: never guess which repo is intended.
  const name = typeof requestedName === "string" ? requestedName.normalize("NFC").trim() : "";
  if (!name || name.length > 128 || /[\u0000-\u001f\u007f]/u.test(name)) {
    return { status: "not_found", requested_name: name, matches: [], next_action: "list_projects" };
  }
  const key = normalized(name);
  const matches = projects.filter((project) =>
    normalized(project.name) === key || normalized(project.directory_name) === key
  );
  const status = matches.length === 1 ? "unique" : matches.length ? "ambiguous" : "not_found";
  return {
    status,
    requested_name: name,
    matches,
    next_action: status === "unique" ? "select_project" :
      status === "ambiguous" ? "ask_user" : "list_projects"
  };
}

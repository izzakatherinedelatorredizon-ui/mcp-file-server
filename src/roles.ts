export type Role = "planner" | "builder" | "reviewer";

export interface Agent {
  name: string;
  role: Role;
}

export const ALL_TOOLS = [
  "list_files",
  "read_file",
  "write_file",
  "str_replace",
  "delete_file",
  "search_files",
  "handoff_read",
  "handoff_append",
  "git_status",
  "git_diff",
  "git_log",
  "git_commit",
] as const;

export type ToolName = (typeof ALL_TOOLS)[number];

const READ_TOOLS: ToolName[] = [
  "list_files",
  "read_file",
  "search_files",
  "handoff_read",
  "handoff_append",
  "git_status",
  "git_diff",
  "git_log",
];

/** Which tools each role can even SEE. Tools not listed are not registered for that role. */
export const ROLE_TOOLS: Record<Role, ToolName[]> = {
  // Plans the work. Can read everything and edit only PROJECT_STATE.md and docs/.
  planner: [...READ_TOOLS, "write_file", "str_replace"],
  // Does the work. The only role that can delete or commit.
  builder: [...READ_TOOLS, "write_file", "str_replace", "delete_file", "git_commit"],
  // Checks the work. Read-only (plus appending to the shared logs).
  reviewer: [...READ_TOOLS],
};

/** Extra path restriction on write_file / str_replace. null = anywhere in the workspace. */
export const ROLE_WRITE_SCOPE: Record<Role, string[] | null> = {
  planner: ["PROJECT_STATE.md", "docs/"],
  builder: null,
  reviewer: [],
};

export function isRole(x: string): x is Role {
  return x === "planner" || x === "builder" || x === "reviewer";
}

import { z } from "zod";
import type { FileOps } from "./fileops.ts";
import type { GitLite } from "./git.ts";
import type { Agent, ToolName } from "./roles.ts";

export interface ToolCtx {
  agent: Agent;
  ops: FileOps;
  git: GitLite;
}

export interface ToolDef {
  name: ToolName;
  title: string;
  description: string;
  schema: z.ZodRawShape;
  readOnly: boolean;
  destructive: boolean;
  handler: (ctx: ToolCtx, args: any) => Promise<string> | string;
}

const path = (what = "Path relative to the workspace root, e.g. \"src/app.ts\". No absolute paths or \"..\".") =>
  z.string().min(1).max(1024).describe(what);
const version = z.string().regex(/^[0-9a-f]{16}$/).describe("The `version` string shown by read_file / write_file output.");

export const TOOLS: ToolDef[] = [
  {
    name: "list_files",
    title: "List files",
    description:
      "List files and folders in a workspace directory (names and sizes only, never contents). Start here to orient yourself. Use recursive=true for a tree; output is capped by max_entries.",
    schema: {
      path: path("Directory to list. Default: workspace root.").default("."),
      recursive: z.boolean().default(false).describe("Also list subdirectories (max depth 6)."),
      max_entries: z.number().int().min(1).max(500).default(200),
    },
    readOnly: true,
    destructive: false,
    handler: (c, a) => c.ops.listFiles(a.path, a),
  },
  {
    name: "read_file",
    title: "Read a text file",
    description:
      "Read a UTF-8 text file. Returns a header with the file `version` (needed to overwrite it later) and the requested lines. Large files are returned in chunks: use start_line/end_line to page, or search_files to locate what you need first.",
    schema: {
      path: path(),
      start_line: z.number().int().min(1).default(1).describe("First line to return (1-based)."),
      end_line: z.number().int().min(1).optional().describe("Last line to return (inclusive). Default: end of file."),
      max_chars: z.number().int().min(200).max(20000).default(20000).describe("Output size cap."),
    },
    readOnly: true,
    destructive: false,
    handler: (c, a) => c.ops.readFile(a.path, a),
  },
  {
    name: "write_file",
    title: "Create or overwrite a file",
    description:
      "Create a new text file (parent folders are created), or replace a whole existing file. To overwrite you MUST pass expected_version from a prior read_file - this prevents clobbering another agent's work. For small edits prefer str_replace. Cannot write the append-only logs (use handoff_append).",
    schema: {
      path: path(),
      content: z.string().max(1_000_000).describe("Full new file content."),
      expected_version: version.optional().describe("Required when the file already exists."),
    },
    readOnly: false,
    destructive: false,
    handler: (c, a) => c.ops.writeFile(a.path, a.content, c.agent, a.expected_version),
  },
  {
    name: "str_replace",
    title: "Replace text in a file",
    description:
      "Replace an exact piece of text in an existing file. old_str must match exactly once (include surrounding lines to make it unique) unless replace_all=true. Cheaper and safer than rewriting the whole file.",
    schema: {
      path: path(),
      old_str: z.string().min(1).max(100_000).describe("Exact text to find (whitespace-sensitive)."),
      new_str: z.string().max(100_000).describe("Replacement text (may be empty to delete)."),
      replace_all: z.boolean().default(false),
      expected_version: version.optional().describe("Optional guard: fail if the file changed since you read it."),
    },
    readOnly: false,
    destructive: false,
    handler: (c, a) => c.ops.strReplace(a.path, a.old_str, a.new_str, c.agent, a),
  },
  {
    name: "delete_file",
    title: "Delete a file (moves to .trash)",
    description:
      "DESTRUCTIVE. Delete a single file. Requires confirm=true. The file is moved to .trash (recoverable by the operator), not erased. Handoff files cannot be deleted. Only available to the builder role.",
    schema: {
      path: path(),
      confirm: z.boolean().describe("Must be true. Set it only when you are sure the file should go."),
    },
    readOnly: false,
    destructive: true,
    handler: (c, a) => c.ops.deleteFile(a.path, a.confirm, c.agent),
  },
  {
    name: "search_files",
    title: "Search file contents",
    description:
      "Find lines containing text (or a regex) across the workspace, returning path:line: snippet. Use this instead of reading many files. Optional glob like \"*.js\" or \"src/**/*.ts\" narrows the files searched.",
    schema: {
      pattern: z.string().min(1).max(200).describe("Text to find (literal unless regex=true)."),
      path: path("Directory or file to search. Default: whole workspace.").default("."),
      glob: z.string().max(100).optional().describe("Only search files matching this glob."),
      regex: z.boolean().default(false),
      case_sensitive: z.boolean().default(false),
      max_results: z.number().int().min(1).max(200).default(50),
    },
    readOnly: true,
    destructive: false,
    handler: (c, a) => c.ops.searchFiles(a.pattern, a.path, a),
  },
  {
    name: "handoff_read",
    title: "Read all handoff files",
    description:
      "Read PROJECT_STATE.md, PLAN_LOG.md, CHECKPOINTS.md and DECISIONS.md in ONE call. Call this first in every session to learn the current state and what the previous agent did. Long logs show their most recent entries.",
    schema: {
      max_chars_each: z.number().int().min(200).max(6000).default(3000),
    },
    readOnly: true,
    destructive: false,
    handler: (c, a) => c.ops.handoffRead(a.max_chars_each),
  },
  {
    name: "handoff_append",
    title: "Append to a handoff log",
    description:
      "Append a timestamped, attributed entry to PLAN_LOG.md (what you plan/did), CHECKPOINTS.md (a verified milestone) or DECISIONS.md (a choice and why). These logs are append-only. To update the current summary, edit PROJECT_STATE.md with write_file/str_replace instead.",
    schema: {
      file: z.enum(["PLAN_LOG.md", "CHECKPOINTS.md", "DECISIONS.md"]),
      entry: z.string().min(1).max(4000).describe("Concise entry; the server adds timestamp and your agent name."),
    },
    readOnly: false,
    destructive: false,
    handler: (c, a) => c.ops.handoffAppend(a.file, a.entry, c.agent),
  },
  {
    name: "git_status",
    title: "Git status",
    description: "Show branch and uncommitted changes in the workspace repository (short porcelain format).",
    schema: {},
    readOnly: true,
    destructive: false,
    handler: (c) => c.git.status(),
  },
  {
    name: "git_diff",
    title: "Git diff",
    description:
      "Show a diff (stat + patch) of the working tree. With ref (e.g. \"HEAD~1\" or a commit hash) it compares that commit to the working tree - handy for reviewing the last commit. Optional path limits it to one file.",
    schema: {
      ref: z.string().max(100).optional().describe("Commit-ish such as HEAD~1 or an abbreviated hash."),
      path: path("Limit the diff to this path.").optional(),
    },
    readOnly: true,
    destructive: false,
    handler: (c, a) => c.git.diff(a),
  },
  {
    name: "git_log",
    title: "Git log",
    description: "Show recent commits (hash, date, author, subject). Authors are the agent roles that committed.",
    schema: {
      max_count: z.number().int().min(1).max(50).default(10),
      path: path("Only commits touching this path.").optional(),
    },
    readOnly: true,
    destructive: false,
    handler: (c, a) => c.git.log(a),
  },
  {
    name: "git_commit",
    title: "Git commit",
    description:
      "Stage and commit changes in the workspace. With no paths, commits everything that changed; pass paths to commit only those. The commit is authored by your agent role. Only available to the builder role.",
    schema: {
      message: z.string().min(3).max(500).describe("Commit message, imperative mood."),
      paths: z.array(path()).max(50).optional().describe("Limit the commit to these paths."),
    },
    readOnly: false,
    destructive: false,
    handler: (c, a) => c.git.commit(a.message, c.agent.name, a.paths),
  },
];

/** Shared base catalog. Design grants alone never authorize these local tools. */
export const WORKSPACE_TOOL_SCOPES = {
  workspace_info: "workspace.read",
  list_directory: "workspace.read",
  read_file: "workspace.read",
  read_image: "workspace.read",
  search_workspace: "workspace.search",
  git_status: "git.read",
  git_diff: "git.read",
  test_status: "execution.read",
  execution_summary: "execution.read",
  execution_output: "execution.read",
  write_file: "workspace.write",
  apply_patch: "workspace.write",
  run_command: "workspace.execute",
} as const;
export const WORKSPACE_TOOLS = Object.keys(WORKSPACE_TOOL_SCOPES) as (keyof typeof WORKSPACE_TOOL_SCOPES)[];
export function workspaceToolScope(name: string): string | undefined {
  return Object.hasOwn(WORKSPACE_TOOL_SCOPES, name)
    ? WORKSPACE_TOOL_SCOPES[name as keyof typeof WORKSPACE_TOOL_SCOPES] : undefined;
}
export function hasRelayScope(scopes: readonly string[], required: string): boolean {
  return scopes.includes(required) || (required === "workspace.read" && scopes.includes("workspace.write"));
}

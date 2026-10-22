export type WorkspaceDefaultMachine =
  | { kind: "managed" }
  | { kind: "machine"; targetSandboxId: string };

export function workspaceDefaultMachine(
  settings: Record<string, unknown> | undefined,
): WorkspaceDefaultMachine | null {
  const value = settings?.defaultExecutionTarget;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if ("kind" in value && value.kind === "managed") return { kind: "managed" };
  if (
    "kind" in value &&
    value.kind === "machine" &&
    "targetSandboxId" in value &&
    typeof value.targetSandboxId === "string" &&
    value.targetSandboxId
  )
    return { kind: "machine", targetSandboxId: value.targetSandboxId };
  return null;
}

/** Fresh composer defaults precede remembered project choices; saved drafts stay explicit. */
export function initialWorkspaceMachineCompute(input: {
  settings: Record<string, unknown> | undefined;
  options: Pick<
    import("@opengeni/sdk").NewSessionDraftOptions,
    "targetSandboxId" | "sandboxBackend" | "workingDir"
  >;
  fallback: import("./session-create").SessionDraft["compute"];
  backend: import("@opengeni/sdk").SandboxBackend | undefined;
}): import("./session-create").SessionDraft["compute"] {
  const target = workspaceDefaultMachine(input.settings);
  if (
    !target ||
    input.options.targetSandboxId ||
    input.options.sandboxBackend ||
    input.options.workingDir
  )
    return input.fallback;
  return target.kind === "machine"
    ? { kind: "machine", sandboxId: target.targetSandboxId, folder: { kind: "root" } }
    : { kind: "sandbox", backend: input.backend === "selfhosted" ? "" : (input.backend ?? "") };
}

import { z } from "zod";

export const SandboxMachineState = z.enum([
  "absent",
  "running",
  "suspended",
  "destroying",
  "destroyed",
]);
export const SandboxMachineTarget = z.enum(["running", "suspended", "destroyed"]);
export const SandboxMachineScope = z
  .object({
    workspaceId: z.string().min(1),
    sandboxGroupId: z.string().min(1),
  })
  .strict();
export const SandboxMachineInstance = z
  .object({
    id: z.string().min(1),
    bootId: z.string().min(1),
    diskLineage: z.string().min(1),
  })
  .strict();
export const SandboxMachineDemand = z
  .object({
    id: z.string().min(1),
    owner: z.string().min(1),
    kind: z.enum(["attempt", "command", "file", "viewer", "terminal", "browser", "desktop"]),
    authority: z.string().min(1),
  })
  .strict();
export const SandboxMachineTransition = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["create", "resume", "suspend", "destroy"]),
    phase: z.enum(["reserved", "dispatched", "unknown"]),
    /** Nonsecret provider configuration sealed before dispatch. Recovery must
     * use this definition even when deployment defaults have changed. */
    definition: z.json().optional(),
    before: z
      .object({
        state: SandboxMachineState,
        instance: SandboxMachineInstance.nullable(),
        disk: z.json(),
      })
      .strict(),
  })
  .strict();

/** Internal durable machine projection. It grants no session, user or attempt
 * authority and is never accepted as a public session-create option. */
export const SandboxMachineRecord = SandboxMachineScope.extend({
  id: z.string().min(1),
  provider: z.string().min(1),
  version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  state: SandboxMachineState,
  target: SandboxMachineTarget,
  instance: SandboxMachineInstance.nullable(),
  disk: z.json(),
  demands: z.array(SandboxMachineDemand),
  idleSince: z.number().finite().nonnegative().nullable(),
  transition: SandboxMachineTransition.nullable(),
})
  .strict()
  .refine(
    (machine) =>
      machine.state !== "destroying" ||
      (machine.target === "destroyed" &&
        machine.instance === null &&
        machine.disk !== null &&
        machine.demands.length === 0),
    "Partially destroyed machines retain only their remaining disk cleanup",
  );

export type SandboxMachineState = z.infer<typeof SandboxMachineState>;
export type SandboxMachineTarget = z.infer<typeof SandboxMachineTarget>;
export type SandboxMachineScope = z.infer<typeof SandboxMachineScope>;
export type SandboxMachineInstance = z.infer<typeof SandboxMachineInstance>;
export type SandboxMachineDemand = z.infer<typeof SandboxMachineDemand>;
export type SandboxMachineTransition = z.infer<typeof SandboxMachineTransition>;
export type SandboxMachineRecord = z.infer<typeof SandboxMachineRecord>;

export type SandboxEngine = "legacy" | "machine-v2";

/** Server qualification and both opt-ins gate fresh admission only. A stored
 * engine is authoritative even after settings change or an adapter is removed. */
export function selectSandboxEngine(input: {
  deploymentEnabled: boolean;
  workspaceEnabled: boolean;
  recorded: SandboxEngine | null;
  isNewGroup: boolean;
  backend: string;
  qualifiedBackends: ReadonlySet<string>;
}): SandboxEngine {
  if (input.recorded) return input.recorded;
  if (!input.isNewGroup || ["none", "local", "selfhosted"].includes(input.backend)) return "legacy";
  return input.deploymentEnabled &&
    input.workspaceEnabled &&
    input.qualifiedBackends.has(input.backend)
    ? "machine-v2"
    : "legacy";
}

export function workspaceSandboxV2Enabled(settings: unknown): boolean {
  return (
    typeof settings === "object" &&
    settings !== null &&
    !Array.isArray(settings) &&
    (settings as Record<string, unknown>)["sandboxV2Enabled"] === true
  );
}

export function initialSandboxMachine(
  scope: SandboxMachineScope,
  provider: string,
  id: string,
): SandboxMachineRecord {
  return {
    workspaceId: scope.workspaceId,
    sandboxGroupId: scope.sandboxGroupId,
    id,
    provider,
    version: 0,
    state: "absent",
    target: "suspended",
    instance: null,
    disk: null,
    demands: [],
    idleSince: null,
    transition: null,
  };
}

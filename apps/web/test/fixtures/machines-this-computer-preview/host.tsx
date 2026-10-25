// Deterministic app data for the preview; the screens are the production ones.
import type { MachineView } from "@opengeni/sdk";

export const staging = {
  sandboxId: "staging",
  enrollmentId: "staging-enrollment",
  scope: "workspace",
  generation: 1,
  name: "cloudgeni-staging-workspace",
  kind: "selfhosted",
  state: "online",
  active: false,
  isSessionGroup: false,
  workspaceGeneration: null,
  archiveGeneration: null,
  archiveComplete: false,
  os: "linux",
  arch: "x86_64",
  hasDisplay: true,
  allowScreenControl: false,
  sharedSessionCount: 0,
  lastSeenAt: new Date().toISOString(),
  connectionAuthority: {
    state: "active",
    generation: 1,
    supersededCount: 0,
    leaseExpiresAt: null,
    duplicateRunnerDeniedCount: 0,
    duplicateRunnerDeniedAt: null,
  },
  runtime: null,
  operationPolicy: null,
  metrics: null,
} as unknown as MachineView;

export function useAppContext() {
  return {
    clientConfig: { connectedMachines: true },
    client: {
      mintEnrollToken: async (_workspace: string, choice: object) => ({
        token: "oget_preview.only",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        expiresInSeconds: 3600,
        ...choice,
      }),
    },
    accessContext: { subjectId: "person" },
  };
}

export function useWorkspaceMachines() {
  return { machines: [staging], loading: false, error: null };
}

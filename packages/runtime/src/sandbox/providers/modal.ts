import { ModalImageSelector, ModalSandboxClient } from "@openai/agents-extensions/sandbox/modal";
import { effectiveModalIdleTimeoutSeconds } from "@opengeni/config";
import type { Settings } from "@opengeni/config";
import { CAPABILITY_DESCRIPTORS } from "../capabilities";
import { SandboxConfigError } from "../errors";
import type { ProviderRegistration } from "./types";

const MODAL_ORPHAN_SWEEP_LIMIT = 50;
const MODAL_UNATTRIBUTED_ORPHAN_GRACE_MS = 30 * 60_000;

export type ModalSandboxAttribution = {
  leaseId: string;
  workspaceId: string;
  sandboxGroupId: string;
};

export type LiveModalSandboxLeaseAttribution = ModalSandboxAttribution & {
  instanceId: string | null;
  liveness?: string;
};

export type ModalOrphanSweepTermination = {
  sandboxId: string;
  reason: "stale_attribution" | "unattributed";
  tags: Record<string, string>;
};

export type ModalOrphanSweepResult = {
  examined: number;
  terminated: ModalOrphanSweepTermination[];
  skipped: number;
};

export function modalSandboxAttributionEnvironment(input: ModalSandboxAttribution): Record<string, string> {
  return {
    OPENGENI_SANDBOX_LEASE_ID: input.leaseId,
    OPENGENI_SANDBOX_GROUP_ID: input.sandboxGroupId,
    OPENGENI_WORKSPACE_ID: input.workspaceId,
  };
}

export function modalSandboxAttributionTags(input: ModalSandboxAttribution): Record<string, string> {
  return {
    opengeni: "true",
    opengeni_lease_id: input.leaseId,
    opengeni_workspace_id: input.workspaceId,
    opengeni_sandbox_group_id: input.sandboxGroupId,
  };
}

export const modalProvider: ProviderRegistration = {
  backend: "modal",
  descriptor: CAPABILITY_DESCRIPTORS.modal,
  validateCredentials(settings) {
    // both-or-neither (preserves existing validation at config validateSettings).
    if (Boolean(settings.modalTokenId) !== Boolean(settings.modalTokenSecret)) {
      throw new SandboxConfigError(
        "modal",
        "OPENGENI_MODAL_TOKEN_ID and OPENGENI_MODAL_TOKEN_SECRET must both be set or both omitted",
      );
    }
    if (!settings.modalAppName) {
      throw new SandboxConfigError("modal", "OPENGENI_MODAL_APP_NAME is required");
    }
  },
  build({ settings, environment, exposedPorts }) {
    const options: NonNullable<ConstructorParameters<typeof ModalSandboxClient>[0]> = {
      appName: settings.modalAppName,
      timeoutMs: settings.modalTimeoutSeconds * 1000,
      sandboxCreateTimeoutS: Math.ceil(settings.sandboxWarmingTimeoutMs / 1000),
      exposedPorts,
      env: environment,
      // The Modal JS SDK's sandbox default command already sleeps until timeout
      // or explicit termination. Do not let the Agents extension stamp a separate
      // hardcoded sleep command; OPENGENI_MODAL_TIMEOUT_SECONDS owns lifetime.
      useSleepCmd: false,
    };
    // gap-fill (module 03 §4.1): these SDK options were previously unmapped.
    // ALWAYS pin idleTimeoutMs (sandbox-file-persistence): an UNSET idle timeout
    // lets the SDK send idleTimeoutSecs=undefined, so Modal applies its short
    // server-default idle-reap and kills an idle (between-turns) box LONG before
    // OpenGeni's reaper can resume+snapshot it. effectiveModalIdleTimeoutSeconds
    // defaults this to the hard lifetime so the box survives its full warm window
    // and the reaper — not Modal's idle-reap — governs teardown (and snapshots
    // /workspace first).
    options.idleTimeoutMs = effectiveModalIdleTimeoutSeconds(settings) * 1000;
    if (settings.modalWorkspacePersistence) {
      options.workspacePersistence = settings.modalWorkspacePersistence;
    }
    if (settings.modalImageRef) {
      options.image = ModalImageSelector.fromTag(settings.modalImageRef);
    }
    if (settings.modalTokenId) {
      options.tokenId = settings.modalTokenId;
    }
    if (settings.modalTokenSecret) {
      options.tokenSecret = settings.modalTokenSecret;
    }
    if (settings.modalEnvironment) {
      options.environment = settings.modalEnvironment;
    }
    return new ModalSandboxClient(options);
  },
};

type ModalModule = typeof import("modal");
type ModalClientLike = InstanceType<ModalModule["ModalClient"]>;

function modalClientOptions(settings: Settings): ConstructorParameters<ModalModule["ModalClient"]>[0] {
  return {
    ...(settings.modalTokenId ? { tokenId: settings.modalTokenId } : {}),
    ...(settings.modalTokenSecret ? { tokenSecret: settings.modalTokenSecret } : {}),
    ...(settings.modalEnvironment ? { environment: settings.modalEnvironment } : {}),
    ...(settings.modalTimeoutSeconds ? { timeoutMs: settings.modalTimeoutSeconds * 1000 } : {}),
  };
}

async function createModalClient(settings: Settings): Promise<ModalClientLike> {
  const modal = await import("modal");
  return new modal.ModalClient(modalClientOptions(settings));
}

export async function tagModalSandbox(
  settings: Settings,
  sandboxId: string,
  attribution: ModalSandboxAttribution,
): Promise<boolean> {
  if (!sandboxId) {
    return false;
  }
  const modal = await createModalClient(settings);
  try {
    const sandbox = await modal.sandboxes.fromId(sandboxId);
    await sandbox.setTags(modalSandboxAttributionTags(attribution));
    return true;
  } finally {
    modal.close();
  }
}

export async function terminateModalSandboxById(settings: Settings, sandboxId: string): Promise<boolean> {
  if (!sandboxId) {
    return true;
  }
  const modal = await createModalClient(settings);
  try {
    const sandbox = await modal.sandboxes.fromId(sandboxId);
    await sandbox.terminate();
    return true;
  } finally {
    modal.close();
  }
}

type ModalSandboxInfo = {
  id: string;
  createdAt?: number;
  tags?: Array<{ tagName?: string; tagValue?: string }>;
};

type ModalCpListClient = ModalClientLike & {
  cpClient: {
    sandboxList(input: {
      appId?: string;
      beforeTimestamp?: number;
      environmentName?: string;
      includeFinished?: boolean;
      tags?: Array<{ tagName: string; tagValue: string }>;
    }): Promise<{ sandboxes?: ModalSandboxInfo[] }>;
  };
};

function tagsFromInfo(info: ModalSandboxInfo): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const tag of info.tags ?? []) {
    if (typeof tag.tagName === "string" && typeof tag.tagValue === "string") {
      tags[tag.tagName] = tag.tagValue;
    }
  }
  return tags;
}

function sandboxCreatedAtMs(info: ModalSandboxInfo): number | null {
  if (typeof info.createdAt !== "number" || !Number.isFinite(info.createdAt) || info.createdAt <= 0) {
    return null;
  }
  // Modal protobuf timestamps in this SDK are seconds as doubles.
  return info.createdAt < 10_000_000_000 ? Math.floor(info.createdAt * 1000) : Math.floor(info.createdAt);
}

function attributionKey(input: Pick<ModalSandboxAttribution, "leaseId" | "workspaceId" | "sandboxGroupId">): string {
  return `${input.workspaceId}:${input.sandboxGroupId}:${input.leaseId}`;
}

export async function sweepModalOrphanSandboxes(
  settings: Settings,
  liveLeases: LiveModalSandboxLeaseAttribution[],
  options: {
    now?: Date;
    maxTerminations?: number;
    unattributedGraceMs?: number;
    client?: ModalClientLike;
  } = {},
): Promise<ModalOrphanSweepResult> {
  const nowMs = options.now?.getTime() ?? Date.now();
  const maxTerminations = options.maxTerminations ?? MODAL_ORPHAN_SWEEP_LIMIT;
  const unattributedGraceMs = options.unattributedGraceMs ?? MODAL_UNATTRIBUTED_ORPHAN_GRACE_MS;
  const liveByAttribution = new Map(liveLeases.map((lease) => [attributionKey(lease), lease]));
  const ownedClient = options.client ? null : await createModalClient(settings);
  const modal = (options.client ?? ownedClient)! as ModalCpListClient;
  try {
    const app = await modal.apps.fromName(settings.modalAppName, {
      createIfMissing: false,
      ...(settings.modalEnvironment ? { environment: settings.modalEnvironment } : {}),
    });
    const appId = app.appId;
    if (!appId) {
      return { examined: 0, terminated: [], skipped: 0 };
    }

    let examined = 0;
    let skipped = 0;
    const terminated: ModalOrphanSweepTermination[] = [];
    let beforeTimestamp: number | undefined;
    while (terminated.length < maxTerminations) {
      const response = await modal.cpClient.sandboxList({
        appId,
        ...(beforeTimestamp !== undefined ? { beforeTimestamp } : {}),
        includeFinished: false,
        ...(settings.modalEnvironment ? { environmentName: settings.modalEnvironment } : {}),
        tags: [],
      });
      const sandboxes = response.sandboxes ?? [];
      if (sandboxes.length === 0) {
        break;
      }
      for (const info of sandboxes) {
        examined += 1;
        const tags = tagsFromInfo(info);
        const leaseId = tags.opengeni_lease_id;
        const workspaceId = tags.opengeni_workspace_id;
        const sandboxGroupId = tags.opengeni_sandbox_group_id;
        let reason: ModalOrphanSweepTermination["reason"] | null = null;
        if (leaseId && workspaceId && sandboxGroupId) {
          const live = liveByAttribution.get(attributionKey({ leaseId, workspaceId, sandboxGroupId }));
          if (!live || (live.instanceId && live.instanceId !== info.id)) {
            reason = "stale_attribution";
          }
        } else {
          const createdAtMs = sandboxCreatedAtMs(info);
          if (createdAtMs !== null && nowMs - createdAtMs >= unattributedGraceMs) {
            reason = "unattributed";
          }
        }

        if (!reason) {
          skipped += 1;
          continue;
        }
        try {
          const sandbox = await modal.sandboxes.fromId(info.id);
          await sandbox.terminate();
          terminated.push({ sandboxId: info.id, reason, tags });
        } catch {
          skipped += 1;
        }
        if (terminated.length >= maxTerminations) {
          break;
        }
      }
      beforeTimestamp = sandboxes[sandboxes.length - 1]?.createdAt;
      if (beforeTimestamp === undefined) {
        break;
      }
    }
    return { examined, terminated, skipped };
  } finally {
    ownedClient?.close();
  }
}

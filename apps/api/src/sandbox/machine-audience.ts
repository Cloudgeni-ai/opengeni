// Changing who can use a Connected Machine (Workspace or Only me) in place.
// The routes in ../routes/machines.ts stay thin: this module owns who may ask
// for which change, and the public shape of the preview and its refusals. The
// database functions recompute everything under the machine lock, so these
// checks only decide whether the caller may ask at all.

import {
  ChangeMachineAudienceResponse,
  MachineAudiencePreview,
  type MachineAudience,
} from "@opengeni/contracts";
import type {
  MachineAudienceChangeRecord,
  MachineAudiencePreviewRecord,
  MachineAudienceRefusal,
} from "@opengeni/db";
import { ApiHttpError } from "../http/api-error";

type AudienceCaller = {
  subjectId: string;
  permissions: readonly string[];
};

type AudienceMachine = {
  workspaceId: string;
  scope: "organization" | "workspace" | "user";
};

/**
 * Decide whether the caller may ask for this change and who would own the
 * machine. Narrowing to Only me: the person who will own it, or a workspace
 * admin acting for that person. Sharing with the workspace: a workspace admin
 * (the database also requires the caller to be the machine's owner, so nobody
 * can expose another person's Only me machine).
 */
export function machineAudienceRequestFor(
  caller: AudienceCaller,
  routeWorkspaceId: string,
  machine: AudienceMachine,
  request: { audience: MachineAudience; ownerSubjectId?: string | undefined },
): { ownerSubjectId: string | null } {
  if (machine.scope === "organization") {
    throw new ApiHttpError(422, {
      code: "validation_failed",
      message:
        "Organization machines are shared with the whole organization and can't be changed here.",
      retryable: false,
    });
  }
  if (machine.workspaceId !== routeWorkspaceId) {
    throw new ApiHttpError(409, {
      code: "conflict",
      message: "Change who can use this machine from the workspace it was connected to.",
      retryable: false,
      details: { machineWorkspaceId: machine.workspaceId },
    });
  }
  const workspaceAdmin = caller.permissions.includes("workspace:admin");
  if (request.audience === "workspace") {
    if (request.ownerSubjectId !== undefined) {
      throw new ApiHttpError(400, {
        code: "validation_failed",
        message: "A machine shared with the workspace has no single owner.",
        retryable: false,
      });
    }
    if (!workspaceAdmin) {
      throw new ApiHttpError(403, {
        code: "forbidden",
        message: "missing permission: workspace:admin",
        retryable: false,
      });
    }
    return { ownerSubjectId: null };
  }
  const ownerSubjectId = request.ownerSubjectId ?? caller.subjectId;
  if (ownerSubjectId !== caller.subjectId && !workspaceAdmin) {
    throw new ApiHttpError(403, {
      code: "forbidden",
      message: "missing permission: workspace:admin",
      retryable: false,
    });
  }
  return { ownerSubjectId };
}

const REFUSALS: Record<MachineAudienceRefusal, { status: number; message: string }> = {
  machine_not_found: { status: 404, message: "machine not found in this access scope" },
  organization_machine: {
    status: 422,
    message:
      "Organization machines are shared with the whole organization and can't be changed here.",
  },
  invalid_target: { status: 400, message: "Choose Workspace or Only me." },
  already_target: { status: 409, message: "The machine already has this audience." },
  owner_not_member: {
    status: 422,
    message: "The new owner must be an active member of this organization.",
  },
  owner_lacks_workspace_access: {
    status: 422,
    message: "The new owner must be able to use this workspace.",
  },
  not_machine_owner: {
    status: 403,
    message: "Only the machine's owner can share it with the workspace.",
  },
};

export function machineAudienceRefusalError(refusal: MachineAudienceRefusal): ApiHttpError {
  const known = REFUSALS[refusal] ?? { status: 409, message: "The machine can't change now." };
  return new ApiHttpError(known.status, {
    code:
      known.status === 404
        ? "not_found"
        : known.status === 403
          ? "forbidden"
          : known.status === 409
            ? "conflict"
            : "validation_failed",
    message: known.message,
    retryable: false,
    details: { refusal },
  });
}

export function machineAudiencePreview(
  record: MachineAudiencePreviewRecord,
): MachineAudiencePreview {
  return MachineAudiencePreview.parse({
    enrollmentId: record.enrollmentId,
    sandboxId: record.sandboxId,
    machineName: record.machineName,
    currentAudience: record.currentAudience,
    targetAudience: record.targetAudience,
    generation: record.generation,
    ownerSubjectId: record.targetAudience === "only_me" ? record.ownerSubjectId : null,
    summary: record.summary,
    ready: record.ready,
    items: record.items.map((item) => ({
      kind: item.kind,
      action: item.action,
      sessionId: item.sessionId ?? null,
      scheduledTaskId: item.scheduledTaskId ?? null,
      enrollmentId: item.enrollmentId ?? null,
      workspaceId: item.workspaceId ?? null,
      relation: item.relation ?? null,
      visibility: item.visibility ?? null,
      title: (item.kind === "schedule" ? item.name : item.title) ?? null,
      ownerSubjectId: item.ownerSubjectId ?? null,
      stopsTurn: item.stopsTurn ?? false,
      stopsCommands: item.stopsCommands ?? 0,
    })),
  });
}

/** Map an applied change, or explain why nothing changed. */
export function machineAudienceChangeResponse(
  record: MachineAudienceChangeRecord,
): ChangeMachineAudienceResponse {
  switch (record.outcome) {
    case "changed":
      return ChangeMachineAudienceResponse.parse({
        enrollmentId: record.enrollmentId,
        sandboxId: record.sandboxId,
        previousAudience: record.previousAudience,
        audience: record.audience,
        ownerSubjectId: record.ownerSubjectId,
        generation: record.generation,
        summary: record.summary,
        detachedSessionIds: record.detachedSessionIds,
        keptSessionIds: record.keptSessionIds,
      });
    case "stale":
      throw new ApiHttpError(409, {
        code: "conflict",
        message: "The machine changed since you reviewed it. Review the list again.",
        retryable: false,
        details: { reason: "stale", generation: record.generation },
      });
    case "blocked":
      throw new ApiHttpError(409, {
        code: "conflict",
        message:
          "This computer is also connected as a separate machine. Remove that copy first, then try again.",
        retryable: false,
        details: { reason: "blocked", preview: machineAudiencePreview(record.preview) },
      });
    case "refused":
      throw machineAudienceRefusalError(record.refusal);
  }
}

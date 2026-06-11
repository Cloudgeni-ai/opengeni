import type { Settings } from "@opengeni/config";
import type { FileAsset, ResourceRef } from "@opengeni/contracts";
import {
  getLatestRunState,
  getSandboxSessionEnvelope,
  getSessionEvent,
  getSessionHistoryItems,
  requireFile,
  type Database,
} from "@opengeni/db";
import type { OpenGeniRuntime } from "@opengeni/runtime";

export async function turnInput(
  db: Database,
  runtime: OpenGeniRuntime,
  agent: any,
  trigger: Awaited<ReturnType<typeof getSessionEvent>>,
  settings?: Settings,
) {
  if (!trigger) {
    throw new Error("Missing trigger event");
  }
  if (trigger.type === "user.message") {
    const payload = trigger.payload as { text?: unknown; resources?: unknown };
    if (typeof payload.text !== "string" || payload.text.trim().length === 0) {
      throw new Error("user.message payload is missing text");
    }
    const text = await userMessageTextWithAttachments(
      db,
      trigger.workspaceId,
      payload.text,
      Array.isArray(payload.resources) ? payload.resources as ResourceRef[] : [],
    );
    return await messageInput(db, runtime, agent, trigger, text, settings);
  }
  if (trigger.type === "goal.continuation") {
    const payload = trigger.payload as { text?: unknown };
    if (typeof payload.text !== "string" || payload.text.trim().length === 0) {
      throw new Error("goal.continuation payload is missing text");
    }
    // Threading the stored conversation keeps the agent's full context across
    // continuations — this is what makes "keep working" coherent.
    return await messageInput(db, runtime, agent, trigger, payload.text, settings);
  }
  if (trigger.type === "user.approvalDecision") {
    const payload = trigger.payload as {
      approvalId?: unknown;
      decision?: unknown;
      message?: unknown;
    };
    // Approvals are the one path that legitimately requires the RunState blob:
    // a turn frozen mid-flight cannot be represented as plain history items.
    const state = await getLatestRunState(db, trigger.workspaceId, trigger.sessionId);
    if (!state) {
      throw new Error("No saved run state is available for approval decision");
    }
    return await runtime.prepareInput(agent, {
      kind: "approval",
      serializedRunState: state.serializedRunState,
      approvalId: String(payload.approvalId ?? ""),
      decision: payload.decision === "approve" ? "approve" : "reject",
      ...(typeof payload.message === "string" ? { message: payload.message } : {}),
    });
  }
  throw new Error(`Unsupported trigger event type: ${trigger.type}`);
}

/**
 * Build a message/continuation turn input from the configured history source.
 * Items mode reads conversation truth from session_history_items and the
 * sandbox envelope from its own store; a session with no stored items yet
 * (created before dual-write, or its first turn) falls back to the RunState
 * blob for this turn — the turn-end reconciliation then backfills its items,
 * so the fallback is self-eliminating (issue #35).
 */
async function messageInput(
  db: Database,
  runtime: OpenGeniRuntime,
  agent: any,
  trigger: NonNullable<Awaited<ReturnType<typeof getSessionEvent>>>,
  text: string,
  settings?: Settings,
) {
  if (settings?.sessionHistorySource === "items") {
    const stored = await getSessionHistoryItems(db, trigger.workspaceId, trigger.sessionId);
    if (stored.length > 0) {
      const envelope = await getSandboxSessionEnvelope(db, trigger.workspaceId, trigger.sessionId);
      return await runtime.prepareInput(agent, {
        kind: "message",
        text,
        historyItems: stored.map((row) => row.item) as any,
        sandboxEnvelope: envelope,
      });
    }
  }
  const latestState = await getLatestRunState(db, trigger.workspaceId, trigger.sessionId);
  return await runtime.prepareInput(agent, {
    kind: "message",
    text,
    serializedRunState: latestState?.serializedRunState ?? null,
  });
}

export async function userMessageTextWithAttachments(
  db: Database,
  workspaceId: string,
  text: string,
  resources: ResourceRef[],
): Promise<string> {
  const attachedFiles: string[] = [];
  for (const resource of resources) {
    if (resource.kind !== "file") {
      continue;
    }
    const file = await requireFile(db, workspaceId, resource.fileId);
    attachedFiles.push(`- ${file.filename} (${file.contentType}, ${file.sizeBytes} bytes): ${sandboxFilePath(resource, file)}`);
  }
  if (attachedFiles.length === 0) {
    return text;
  }
  return [
    text,
    "",
    "Attached files are available in the sandbox:",
    ...attachedFiles,
  ].join("\n");
}

function sandboxFilePath(resource: Extract<ResourceRef, { kind: "file" }>, file: FileAsset): string {
  return `/workspace/${resource.mountPath ?? `files/${file.id}`}/${file.safeFilename}`;
}

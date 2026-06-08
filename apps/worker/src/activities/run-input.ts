import type { FileAsset, ResourceRef } from "@opengeni/contracts";
import {
  getLatestRunState,
  getSessionEvent,
  requireFile,
  type Database,
} from "@opengeni/db";
import type { OpenGeniRuntime } from "@opengeni/runtime";

export async function segmentInput(
  db: Database,
  runtime: OpenGeniRuntime,
  agent: any,
  trigger: Awaited<ReturnType<typeof getSessionEvent>>,
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
    const latestState = await getLatestRunState(db, trigger.workspaceId, trigger.sessionId);
    return await runtime.prepareInput(agent, {
      kind: "message",
      text,
      serializedRunState: latestState?.serializedRunState ?? null,
    });
  }
  if (trigger.type === "user.approvalDecision") {
    const payload = trigger.payload as {
      approvalId?: unknown;
      decision?: unknown;
      message?: unknown;
    };
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

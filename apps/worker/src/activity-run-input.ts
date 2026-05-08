import type { Settings } from "@infra-agents/config";
import type { FileAsset, ResourceRef } from "@infra-agents/contracts";
import {
  getLatestRunState,
  getSessionEvent,
  requireFile,
  type Database,
} from "@infra-agents/db";
import type { InfraAgentRuntime } from "@infra-agents/runtime";
import type { ObjectStorage } from "@infra-agents/storage";

export async function segmentInput(
  db: Database,
  runtime: InfraAgentRuntime,
  agent: any,
  trigger: Awaited<ReturnType<typeof getSessionEvent>>,
  settings: Settings,
  objectStorage: ObjectStorage | null,
) {
  if (!trigger) {
    throw new Error("Missing trigger event");
  }
  if (trigger.type === "user.message") {
    const payload = trigger.payload as { text?: unknown; resources?: unknown };
    if (typeof payload.text !== "string" || payload.text.trim().length === 0) {
      throw new Error("user.message payload is missing text");
    }
    void settings;
    void objectStorage;
    const text = await userMessageTextWithAttachments(
      db,
      payload.text,
      Array.isArray(payload.resources) ? payload.resources as ResourceRef[] : [],
    );
    const latestState = await getLatestRunState(db, trigger.sessionId);
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
    const state = await getLatestRunState(db, trigger.sessionId);
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
  text: string,
  resources: ResourceRef[],
): Promise<string> {
  const attachedFiles: string[] = [];
  for (const resource of resources) {
    if (resource.kind !== "file") {
      continue;
    }
    const file = await requireFile(db, resource.fileId);
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

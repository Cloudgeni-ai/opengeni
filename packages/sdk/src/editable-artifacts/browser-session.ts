import { DOCUMENT_ARTIFACT_COMMAND_VERSION } from "@opengeni/contracts/document-artifact-commands";
import { PRESENTATION_ARTIFACT_COMMAND_VERSION } from "@opengeni/contracts/presentation-artifact-commands";
import { SPREADSHEET_ARTIFACT_COMMAND_VERSION } from "@opengeni/contracts/spreadsheet-artifact-commands";

import type { EditableArtifactCacheAuthority } from "./controller";
import {
  createEditableArtifactHttpLiveTransport,
  type CreateEditableArtifactHttpLiveTransportOptions,
} from "./http-live-transport";
import { createEditableArtifactSession, type EditableArtifactSession } from "./session";
import type { EditableArtifactStoragePort } from "./storage";
import type { EditableArtifactModality } from "./types";
import {
  createBrowserEditableArtifactWorkerKernel,
  type CreateBrowserEditableArtifactWorkerKernelOptions,
} from "./worker/browser-client";

export type EditableArtifactBrowserRuntime = Omit<
  CreateBrowserEditableArtifactWorkerKernelOptions,
  "modality" | "kernelVersion" | "protocolVersion" | "modelSchemaVersion" | "commandVersion"
> &
  Readonly<{
    /** Exact native/WASM build identity admitted by the API. */
    kernelVersion: string;
    modelSchemaVersion: number;
    protocolVersion?: number;
    commandVersion: number;
  }>;

export type CreateBrowserEditableArtifactSessionOptions = Readonly<{
  baseUrl: string | URL;
  workspaceId: string;
  artifact: Readonly<{ id: string; modality: EditableArtifactModality }>;
  /** Exact login/grant partition; rotate authorizationEpoch on authority changes. */
  storageAuthority: EditableArtifactCacheAuthority;
  runtime: EditableArtifactBrowserRuntime;
  transport?: Omit<
    CreateEditableArtifactHttpLiveTransportOptions,
    "baseUrl" | "workspaceId" | "protocolVersion" | "kernelVersion" | "modelSchemaVersion"
  >;
  storage?: EditableArtifactStoragePort;
  /** Reuse the replica used to create the artifact when opening it immediately. */
  replicaId?: string;
}>;

/**
 * One production browser composition point: verified WASM Worker, durable WAL,
 * authenticated HTTP/WebSocket transport, replay, and modality projections.
 */
export function createBrowserEditableArtifactSession(
  options: CreateBrowserEditableArtifactSessionOptions,
): EditableArtifactSession {
  const baseUrl = canonicalBaseUrl(options.baseUrl);
  const workspaceId = boundedIdentity(options.workspaceId, "workspaceId");
  assertCacheAuthority(options.storageAuthority, baseUrl, workspaceId);
  const protocolVersion = positiveVersion(options.runtime.protocolVersion ?? 1, "protocolVersion");
  const modelSchemaVersion = positiveVersion(
    options.runtime.modelSchemaVersion,
    "modelSchemaVersion",
  );
  const kernelVersion = boundedIdentity(options.runtime.kernelVersion, "kernelVersion", 512);
  const commandVersion = positiveVersion(options.runtime.commandVersion, "commandVersion");
  const expectedCommandVersion = commandVersionFor(options.artifact.modality);
  if (commandVersion !== expectedCommandVersion) {
    throw new TypeError(
      `commandVersion ${commandVersion} is incompatible with ${options.artifact.modality} ${expectedCommandVersion}`,
    );
  }
  const {
    kernelVersion: _kernelVersion,
    modelSchemaVersion: _modelSchemaVersion,
    protocolVersion: _protocolVersion,
    commandVersion: _commandVersion,
    ...workerOptions
  } = options.runtime;
  const worker = createBrowserEditableArtifactWorkerKernel({
    ...workerOptions,
    modality: options.artifact.modality,
    kernelVersion,
    protocolVersion,
    modelSchemaVersion,
    commandVersion,
  });
  const replicaId = options.replicaId;
  try {
    const transport = createEditableArtifactHttpLiveTransport({
      ...options.transport,
      baseUrl,
      workspaceId,
      protocolVersion,
      kernelVersion,
      modelSchemaVersion,
    });
    return createEditableArtifactSession({
      artifactId: options.artifact.id,
      modality: options.artifact.modality,
      storageAuthority: options.storageAuthority,
      transport,
      worker,
      ...(options.storage ? { storage: options.storage } : {}),
      kernelVersion,
      modelSchemaVersion,
      commandVersion,
      protocolVersion,
      ...(replicaId ? { writerReplicaIdFactory: () => replicaId } : {}),
      ownsWorker: true,
    });
  } catch (error) {
    void worker.dispose().catch(() => undefined);
    throw error;
  }
}

/** Generates the portable 64-bit nonzero replica identity used by create/open. */
export function createEditableArtifactReplicaId(): string {
  for (;;) {
    const value = [...crypto.getRandomValues(new Uint8Array(8))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    if (value !== "0000000000000000") return value;
  }
}

function commandVersionFor(modality: EditableArtifactModality): number {
  switch (modality) {
    case "spreadsheet":
      return SPREADSHEET_ARTIFACT_COMMAND_VERSION;
    case "document":
      return DOCUMENT_ARTIFACT_COMMAND_VERSION;
    case "presentation":
      return PRESENTATION_ARTIFACT_COMMAND_VERSION;
  }
}

function canonicalBaseUrl(value: string | URL): URL {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError("baseUrl must not contain credentials, query, or fragment");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError("baseUrl must use HTTP or HTTPS");
  }
  return url;
}

function assertCacheAuthority(
  authority: EditableArtifactCacheAuthority,
  baseUrl: URL,
  workspaceId: string,
): void {
  if (new URL(authority.deploymentOrigin).origin !== baseUrl.origin) {
    throw new TypeError("storageAuthority deployment origin does not match baseUrl");
  }
  if (authority.workspaceId !== workspaceId) {
    throw new TypeError("storageAuthority workspace does not match workspaceId");
  }
}

function boundedIdentity(value: string, label: string, maximum = 256): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    new TextEncoder().encode(value).byteLength > maximum
  ) {
    throw new TypeError(`${label} is malformed`);
  }
  return value;
}

function positiveVersion(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new TypeError(`${label} must be a positive 16-bit integer`);
  }
  return value;
}

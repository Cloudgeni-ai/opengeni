import type { OpenGeniClient } from "./client";
import type {
  AppendArchivedSessionEventsRequest,
  AppendArchivedSessionEventsResponse,
  ImportArchivedSessionRequest,
  ImportArchivedSessionResponse,
} from "@opengeni/contracts";

export type {
  ArchivedSessionImportEvent,
  AppendArchivedSessionEventsRequest,
  AppendArchivedSessionEventsResponse,
  ImportArchivedSessionRequest,
  ImportArchivedSessionResponse,
  SessionImportedArchive,
} from "@opengeni/contracts";

type SessionHistoryImportClient = Pick<OpenGeniClient, "requestJson">;

/**
 * Server-only migration of a read-only archive, not model-facing conversation
 * history. Use an asUser client to preserve the verified creator/owner. Persist
 * importId and retry the exact request after an uncertain outcome.
 * Requires sessions:create in the authenticated actor's permissions.
 */
export function importArchivedSession(
  client: SessionHistoryImportClient,
  workspaceId: string,
  request: ImportArchivedSessionRequest,
): Promise<ImportArchivedSessionResponse> {
  return client.requestJson(
    "POST",
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/session-imports`,
    request,
  );
}

/**
 * Append historical events at the acknowledged nextOffset. Retrying the exact
 * batchId, offset and events replays its receipt; conflicting reuse returns 409.
 * Each request accepts at most 100 events / 1 MiB, with 256 KiB per event.
 * Requires sessions:control and the same authenticated importer.
 */
export function appendArchivedSessionEvents(
  client: SessionHistoryImportClient,
  workspaceId: string,
  importId: string,
  request: AppendArchivedSessionEventsRequest,
): Promise<AppendArchivedSessionEventsResponse> {
  return client.requestJson(
    "POST",
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/session-imports/${encodeURIComponent(importId)}/events`,
    request,
  );
}

/** Import through an existing external tenant mapping; this does not onboard it. */
export function importExternalWorkspaceArchivedSession(
  client: SessionHistoryImportClient,
  source: string,
  externalId: string,
  request: ImportArchivedSessionRequest,
): Promise<ImportArchivedSessionResponse> {
  return client.requestJson(
    "POST",
    `/v1/workspaces/external/${encodeURIComponent(source)}/${encodeURIComponent(externalId)}/session-imports`,
    request,
  );
}

/** Append to an archive through the same external tenant mapping and actor. */
export function appendExternalWorkspaceArchivedSessionEvents(
  client: SessionHistoryImportClient,
  source: string,
  externalId: string,
  importId: string,
  request: AppendArchivedSessionEventsRequest,
): Promise<AppendArchivedSessionEventsResponse> {
  return client.requestJson(
    "POST",
    `/v1/workspaces/external/${encodeURIComponent(source)}/${encodeURIComponent(externalId)}/session-imports/${encodeURIComponent(importId)}/events`,
    request,
  );
}

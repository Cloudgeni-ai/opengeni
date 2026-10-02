import type { Session, SessionListEntry } from "./index";
import {
  deriveAutomaticSessionTitlePreview,
  deriveSessionDisplayTitle,
  sessionTitleIsPending,
} from "./session-titles";

/** Explicit list projection. Detail/configuration remains available from getSession. */
export type SessionListEntryInput = Omit<
  SessionListEntry,
  | "displayTitle"
  | "renameSeed"
  | "scheduledTaskId"
  | "siteOrigin"
  | "pinned"
  | "pinnedAt"
  | "pinVersion"
  | "unread"
  | "activelyWorking"
  | "attentionVersion"
  | "archived"
  | "archivedAt"
  | "archiveVersion"
> &
  Partial<
    Pick<
      Session,
      | "pinned"
      | "pinnedAt"
      | "pinVersion"
      | "unread"
      | "activelyWorking"
      | "attentionVersion"
      | "archived"
      | "archivedAt"
      | "archiveVersion"
    >
  > &
  Pick<Session, "metadata" | "initialMessage">;

export function sessionListEntry(session: SessionListEntryInput): SessionListEntry {
  const origin = session.metadata._opengeniSiteOrigin as
    | { siteId?: unknown; title?: unknown }
    | undefined;
  const siteOrigin =
    origin &&
    typeof origin.siteId === "string" &&
    /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(origin.siteId) &&
    typeof origin.title === "string"
      ? { siteId: origin.siteId, title: origin.title }
      : null;
  const scheduledTaskId = session.metadata.scheduledTaskId;
  return {
    id: session.id,
    workspaceId: session.workspaceId,
    accountId: session.accountId,
    status: session.status,
    backgroundCommandActivity: session.backgroundCommandActivity,
    hasSchedules: session.hasSchedules,
    title: session.title,
    titleSource: session.titleSource,
    displayTitle: deriveSessionDisplayTitle(session),
    renameSeed: sessionTitleIsPending(session)
      ? (deriveAutomaticSessionTitlePreview(session.initialMessage) ?? "")
      : (session.title?.trim() ?? ""),
    scheduledTaskId:
      typeof scheduledTaskId === "string" && scheduledTaskId.length > 0 ? scheduledTaskId : null,
    siteOrigin,
    createdBy: session.createdBy,
    channelId: session.channelId,
    parentSessionId: session.parentSessionId,
    rootSessionId: session.rootSessionId,
    effectiveControl: session.effectiveControl,
    inputWait: session.inputWait,
    lastSequence: session.lastSequence,
    pinned: session.pinned ?? false,
    pinnedAt: session.pinnedAt ?? null,
    pinVersion: session.pinVersion ?? 0,
    unread: session.unread ?? false,
    activelyWorking: session.activelyWorking ?? false,
    attentionVersion: session.attentionVersion ?? 0,
    archived: session.archived ?? false,
    archivedAt: session.archivedAt ?? null,
    importedArchive: session.importedArchive,
    archiveVersion: session.archiveVersion ?? 0,
    treeStats: session.treeStats,
    requiresActionSince: session.requiresActionSince,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

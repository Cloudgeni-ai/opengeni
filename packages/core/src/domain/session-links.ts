import {
  classifySessionLinkUrl,
  SESSION_LINKS_MAX,
  SESSION_LINK_TITLE_MAX_LENGTH,
  type SessionLink,
  type SessionLinkAddedBy,
  type SessionLinkKind,
  type SessionWaitingOn,
} from "@opengeni/contracts";
import { updateSessionCoordinationWithEvent, type Database } from "@opengeni/db";
import { publishDurableSessionEvents, type EventBus } from "@opengeni/events";
import { randomUUID } from "node:crypto";

/**
 * A chat's Linked items and who it waits on (see
 * packages/contracts/src/session-links.ts). These helpers write without
 * checking who asks: callers authorize first (the session routes and the
 * agent's own-session tools) or act for Opengeni itself (a pull request the
 * chat opened).
 */

export class SessionLinkLimitError extends Error {
  constructor() {
    super(`A chat holds at most ${SESSION_LINKS_MAX} links. Remove one first.`);
    this.name = "SessionLinkLimitError";
  }
}

export class SessionLinkUrlError extends Error {
  constructor() {
    super("Give an http or https URL.");
    this.name = "SessionLinkUrlError";
  }
}

/** `bus` is the live fanout; without one, viewers catch up from the durable event. */
type CoordinationDeps = { db: Database; bus?: EventBus | null };

/**
 * Add a link, or refresh the title of the same URL already linked. Returns
 * the link as stored, or null when the chat does not exist.
 */
export async function addSessionLink(
  deps: CoordinationDeps,
  input: {
    workspaceId: string;
    sessionId: string;
    url: string;
    title?: string | null | undefined;
    kind?: SessionLinkKind | undefined;
    addedBy: SessionLinkAddedBy;
  },
): Promise<{ link: SessionLink; added: boolean } | null> {
  const classified = classifySessionLinkUrl(input.url);
  if (!classified) throw new SessionLinkUrlError();
  const title = input.title?.trim().slice(0, SESSION_LINK_TITLE_MAX_LENGTH) || null;
  let result: { link: SessionLink; added: boolean } | null = null;
  const written = await updateSessionCoordinationWithEvent(deps.db, {
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    change: ({ links }) => {
      const existing = links.find((link) => link.url === classified.url);
      if (existing) {
        result = { link: existing, added: false };
        if (!title || title === existing.title) return null;
        const updated = { ...existing, title };
        result = { link: updated, added: false };
        return {
          kind: "links",
          links: links.map((link) => (link.id === existing.id ? updated : link)),
        };
      }
      if (links.length >= SESSION_LINKS_MAX) throw new SessionLinkLimitError();
      const link: SessionLink = {
        id: randomUUID(),
        url: classified.url,
        title,
        kind: input.kind ?? classified.kind,
        provider: classified.provider,
        ref: classified.ref,
        addedBy: input.addedBy,
        addedAt: new Date().toISOString(),
      };
      result = { link, added: true };
      return { kind: "links", links: [...links, link] };
    },
  });
  if (!written) return null;
  if (deps.bus) {
    await publishDurableSessionEvents(deps.bus, input.workspaceId, input.sessionId, written.events);
  }
  return result;
}

/** Remove a link by id or URL. Returns whether one was removed; null when the chat does not exist. */
export async function removeSessionLink(
  deps: CoordinationDeps,
  input: { workspaceId: string; sessionId: string; id?: string; url?: string },
): Promise<boolean | null> {
  const url = input.url ? (classifySessionLinkUrl(input.url)?.url ?? input.url) : undefined;
  const written = await updateSessionCoordinationWithEvent(deps.db, {
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    change: ({ links }) => {
      const kept = links.filter(
        (link) => !(input.id && link.id === input.id) && !(url && link.url === url),
      );
      return kept.length === links.length ? null : { kind: "links", links: kept };
    },
  });
  if (!written) return null;
  if (deps.bus) {
    await publishDurableSessionEvents(deps.bus, input.workspaceId, input.sessionId, written.events);
  }
  return written.updated;
}

/**
 * Say who the chat waits on, or clear it (`waitingOn: null`). `turnId` is the
 * turn that said it; the wait shows only while that turn is the chat's latest
 * and the chat is idle.
 */
export async function setSessionWaitingOn(
  deps: CoordinationDeps,
  input: {
    workspaceId: string;
    sessionId: string;
    turnId: string | null;
    waitingOn: Omit<SessionWaitingOn, "source" | "since"> | null;
  },
): Promise<boolean | null> {
  const written = await updateSessionCoordinationWithEvent(deps.db, {
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    change: ({ waitingOn }) => {
      if (!input.waitingOn) return waitingOn ? { kind: "waiting_on", waitingOn: null } : null;
      return {
        kind: "waiting_on",
        waitingOn: {
          source: "agent",
          ...input.waitingOn,
          since: new Date().toISOString(),
          turnId: input.turnId,
        },
      };
    },
  });
  if (!written) return null;
  if (deps.bus) {
    await publishDurableSessionEvents(deps.bus, input.workspaceId, input.sessionId, written.events);
  }
  return written.updated;
}

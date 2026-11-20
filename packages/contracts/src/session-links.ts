import { z } from "zod";
import { defineSchema } from "./define-schema";

/**
 * What a chat is about and who it waits on.
 *
 * A chat's links are the things it works on (issues, pull requests, Slack
 * threads, App records, any URL), shown in its Linked panel. The agent adds
 * them with `session_links_add`; a pull request the chat opens through the
 * GitHub tools is added automatically. Each link's live status is read as
 * the viewer through their own connection, so the stored link holds only
 * what identifies it.
 *
 * `waitingOn` names the person a chat waits on: the agent says so with
 * `set_waiting_on`, and an open question or approval waits on the person the
 * turn works for. It clears when that person replies or approves, or the
 * agent continues.
 *
 * This module must not import `./index`.
 */

export const SESSION_LINKS_MAX = 30;
export const SESSION_LINK_URL_MAX_LENGTH = 2048;
export const SESSION_LINK_TITLE_MAX_LENGTH = 200;
export const SESSION_WAITING_ON_PERSON_MAX_LENGTH = 120;
export const SESSION_WAITING_ON_REASON_MAX_LENGTH = 280;

export const SESSION_LINK_KINDS = ["pull_request", "issue", "thread", "record", "link"] as const;
export const SessionLinkKind = /* @__PURE__ */ defineSchema(() => z.enum(SESSION_LINK_KINDS));
export type SessionLinkKind = z.infer<typeof SessionLinkKind>;

export const SESSION_LINK_PROVIDERS = ["github", "linear", "slack", "opengeni", "other"] as const;
export const SessionLinkProvider = /* @__PURE__ */ defineSchema(() =>
  z.enum(SESSION_LINK_PROVIDERS),
);
export type SessionLinkProvider = z.infer<typeof SessionLinkProvider>;

/** Who added a link: the agent's tool, a person, or Opengeni itself (a PR the chat opened). */
export const SessionLinkAddedBy = /* @__PURE__ */ defineSchema(() =>
  z.enum(["agent", "person", "automatic"]),
);
export type SessionLinkAddedBy = z.infer<typeof SessionLinkAddedBy>;

/**
 * What identifies the linked thing in its own app, parsed from the URL:
 * `owner/repo#number` for GitHub, the issue key for Linear, `channel/ts` for
 * a Slack thread. Null for any other URL.
 */
export const SessionLink = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: z.string().min(1).max(64),
    url: z.string().url().max(SESSION_LINK_URL_MAX_LENGTH),
    title: z.string().max(SESSION_LINK_TITLE_MAX_LENGTH).nullable(),
    kind: SessionLinkKind,
    provider: SessionLinkProvider,
    ref: z.string().max(300).nullable(),
    addedBy: SessionLinkAddedBy,
    addedAt: z.string().datetime({ offset: true }),
  }),
);
export type SessionLink = z.infer<typeof SessionLink>;

export const SessionLinkList = /* @__PURE__ */ defineSchema(() =>
  z.array(SessionLink).max(SESSION_LINKS_MAX),
);

/**
 * A link's live state as one viewer can read it. `unknown` when the viewer has
 * no connection that can read it (the panel then shows the title only).
 */
export const SessionLinkState = /* @__PURE__ */ defineSchema(() =>
  z.enum(["open", "draft", "merged", "closed", "done", "unknown"]),
);
export type SessionLinkState = z.infer<typeof SessionLinkState>;

export const SessionLinkLiveStatus = /* @__PURE__ */ defineSchema(() =>
  z.object({
    state: SessionLinkState,
    /** The app's own word for the state, such as a Linear workflow state. */
    label: z.string().max(80).nullable(),
    title: z.string().max(SESSION_LINK_TITLE_MAX_LENGTH).nullable(),
    checks: z.enum(["passing", "failing", "pending", "none"]).nullable(),
    review: z.enum(["approved", "changes_requested", "review_required", "none"]).nullable(),
  }),
);
export type SessionLinkLiveStatus = z.infer<typeof SessionLinkLiveStatus>;

export const SessionLinkWithStatus = /* @__PURE__ */ defineSchema(() =>
  SessionLink.extend({ status: SessionLinkLiveStatus.nullable() }),
);
export type SessionLinkWithStatus = z.infer<typeof SessionLinkWithStatus>;

export const SessionLinksResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ links: z.array(SessionLinkWithStatus) }),
);
export type SessionLinksResponse = z.infer<typeof SessionLinksResponse>;

export const AddSessionLinkRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({
    url: z.string().url().max(SESSION_LINK_URL_MAX_LENGTH),
    title: z.string().trim().min(1).max(SESSION_LINK_TITLE_MAX_LENGTH).optional(),
    kind: SessionLinkKind.optional(),
  }),
);
export type AddSessionLinkRequest = z.infer<typeof AddSessionLinkRequest>;

/**
 * Who a chat waits on. `agent`: the agent said so; `input`: an open question
 * or approval, which waits on the person the turn works for. `subjectId` is
 * the workspace member when known; `person` is the name to show otherwise.
 */
export const SessionWaitingOn = /* @__PURE__ */ defineSchema(() =>
  z.object({
    source: z.enum(["agent", "input"]),
    person: z.string().max(SESSION_WAITING_ON_PERSON_MAX_LENGTH).nullable(),
    subjectId: z.string().max(200).nullable(),
    reason: z.string().max(SESSION_WAITING_ON_REASON_MAX_LENGTH).nullable(),
    since: z.string().datetime({ offset: true }),
  }),
);
export type SessionWaitingOn = z.infer<typeof SessionWaitingOn>;

/** `session.waiting_on.changed`: null clears it. */
export const SessionWaitingOnChangedPayload = /* @__PURE__ */ defineSchema(() =>
  z.object({ waitingOn: SessionWaitingOn.nullable() }),
);

/** `session.links.changed`: the chat's whole link list after the change. */
export const SessionLinksChangedPayload = /* @__PURE__ */ defineSchema(() =>
  z.object({ links: SessionLinkList }),
);

export type ClassifiedSessionLink = {
  url: string;
  kind: SessionLinkKind;
  provider: SessionLinkProvider;
  ref: string | null;
  github?: { owner: string; repo: string; number: number; type: "pull" | "issue" };
  linear?: { identifier: string };
  slack?: { channel: string; ts: string };
};

/**
 * What a URL points at, from its shape alone. Never fetches. Unknown URLs are
 * plain links shown by title.
 */
export function classifySessionLinkUrl(raw: string): ClassifiedSessionLink | null {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const url = parsed.toString();
  const host = parsed.hostname.toLowerCase();
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (host === "github.com" || host === "www.github.com") {
    const [owner, repo, type, number] = parts;
    const n = Number(number);
    if (
      owner &&
      repo &&
      (type === "pull" || type === "issues") &&
      Number.isSafeInteger(n) &&
      n > 0
    ) {
      const pull = type === "pull";
      return {
        url,
        kind: pull ? "pull_request" : "issue",
        provider: "github",
        ref: `${owner}/${repo}#${n}`,
        github: { owner, repo, number: n, type: pull ? "pull" : "issue" },
      };
    }
    return { url, kind: "link", provider: "github", ref: null };
  }
  if (host === "linear.app") {
    const index = parts.indexOf("issue");
    const identifier = index >= 0 ? parts[index + 1] : undefined;
    if (identifier && /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(identifier)) {
      const key = identifier.toUpperCase();
      return { url, kind: "issue", provider: "linear", ref: key, linear: { identifier: key } };
    }
    return { url, kind: "link", provider: "linear", ref: null };
  }
  if (host.endsWith(".slack.com")) {
    const index = parts.indexOf("archives");
    const channel = index >= 0 ? parts[index + 1] : undefined;
    const message = index >= 0 ? parts[index + 2] : undefined;
    const threadTs = parsed.searchParams.get("thread_ts");
    const fromPath = message?.match(/^p(\d{10})(\d{6})$/);
    const ts = threadTs ?? (fromPath ? `${fromPath[1]}.${fromPath[2]}` : null);
    if (channel && ts) {
      return {
        url,
        kind: "thread",
        provider: "slack",
        ref: `${channel}/${ts}`,
        slack: { channel, ts },
      };
    }
    return { url, kind: "link", provider: "slack", ref: null };
  }
  return { url, kind: "link", provider: "other", ref: null };
}

/** The pull request a GitHub `ref` (`owner/repo#number`) names, or null. */
export function parseGitHubLinkRef(
  ref: string | null,
): { owner: string; repo: string; number: number } | null {
  const match = ref?.match(/^([^/\s]+)\/([^#\s]+)#(\d+)$/);
  if (!match) return null;
  return { owner: match[1]!, repo: match[2]!, number: Number(match[3]) };
}

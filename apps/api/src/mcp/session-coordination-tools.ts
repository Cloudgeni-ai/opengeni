// Who a chat waits on and what it works on: `set_waiting_on` and the
// `session_links_*` tools. Both act on the calling chat only. A link can also
// ask to wake this chat when its pull request merges or its repository
// publishes a release, through the existing event-trigger automations (see
// docs/session-status-and-links.md).
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  classifySessionLinkUrl,
  parseGitHubLinkRef,
  SESSION_LINK_KINDS,
  SESSION_LINK_TITLE_MAX_LENGTH,
  SESSION_LINK_URL_MAX_LENGTH,
  SESSION_WAITING_ON_PERSON_MAX_LENGTH,
  SESSION_WAITING_ON_REASON_MAX_LENGTH,
  type AccessGrant,
  type SessionLink,
} from "@opengeni/contracts";
import {
  addSessionLink,
  removeSessionLink,
  SessionLinkLimitError,
  SessionLinkUrlError,
  setSessionWaitingOn,
  type ApiRouteDeps,
} from "@opengeni/core";
import { getSessionLinks } from "@opengeni/db";
import * as z from "zod/v4";
import { resolveMember } from "./notification-tools";
import { ToolArgumentError } from "./tool-argument-error";

type JsonResult = (value: unknown) => { content: { type: "text"; text: string }[] };

export type SessionLinkWakeEvent = "merged" | "release_published";

/**
 * Creates a one-time event automation that wakes this chat. Present only when
 * the chat may create automations with event triggers; the tool refuses
 * `wakeWhen` otherwise.
 */
export type SessionLinkWake = (input: {
  name: string;
  prompt: string;
  eventType: "pull_request.closed" | "release.published";
  conditions: { field: string; op: "equals"; value: string | number | boolean }[];
}) => Promise<unknown>;

export type RegisterSessionCoordinationToolsInput = {
  server: McpServer;
  deps: ApiRouteDeps;
  grant: AccessGrant;
  sessionId: string;
  authorize: () => Promise<void>;
  /** Read when a tool runs, so a wake set up later in registration is seen. */
  wake: () => SessionLinkWake | null;
  /** The repository's canonical name and the pull request's state, or null when unreadable. */
  wakeTarget: (link: SessionLink) => Promise<{ fullName: string; state: string | null } | null>;
  json: JsonResult;
};

/** The automation that wakes the chat for a GitHub link, or a refusal. */
export function sessionLinkWakeRequest(
  link: Pick<SessionLink, "url" | "ref" | "kind" | "title">,
  when: SessionLinkWakeEvent,
  /** GitHub's own `owner/name` spelling; event conditions compare exactly. */
  canonicalRepository?: string,
): Parameters<SessionLinkWake>[0] {
  const ref = classifySessionLinkUrl(link.url)?.github ?? parseGitHubLinkRef(link.ref);
  if (!ref) {
    throw new ToolArgumentError("wakeWhen works for GitHub pull request links only.");
  }
  const repository = canonicalRepository ?? `${ref.owner}/${ref.repo}`;
  const label = link.title
    ? `${repository}#${ref.number} (${link.title})`
    : `${repository}#${ref.number}`;
  if (when === "merged") {
    if (link.kind !== "pull_request") {
      throw new ToolArgumentError('wakeWhen "merged" works for pull request links only.');
    }
    return {
      name: `When ${repository}#${ref.number} merges`.slice(0, 120),
      prompt: `${label} was merged (${link.url}). Report back where this work started, such as the Slack thread or the person who asked, then finish any follow-up the chat planned for after the merge.`,
      eventType: "pull_request.closed",
      conditions: [
        { field: "data.repository.full_name", op: "equals", value: repository },
        { field: "data.pull_request.number", op: "equals", value: ref.number },
        { field: "data.pull_request.merged", op: "equals", value: true },
      ],
    };
  }
  return {
    name: `When ${repository} publishes a release`.slice(0, 120),
    prompt: `${repository} published a release after ${label} (${link.url}). Check whether the release includes the work, report back where this work started, such as the Slack thread or the person who asked, then finish any follow-up the chat planned.`,
    eventType: "release.published",
    conditions: [{ field: "data.repository.full_name", op: "equals", value: repository }],
  };
}

function linkError(error: unknown): never {
  if (error instanceof SessionLinkLimitError || error instanceof SessionLinkUrlError) {
    throw new ToolArgumentError(error.message);
  }
  throw error;
}

export function registerSessionCoordinationTools(
  input: RegisterSessionCoordinationToolsInput,
): void {
  const { server, deps, grant, sessionId, authorize, json } = input;
  const turnId = typeof grant.metadata?.["turnId"] === "string" ? grant.metadata["turnId"] : null;

  server.registerTool(
    "set_waiting_on",
    {
      description:
        'Show that this chat is waiting on a person, as "Waiting on <person>" in the chat header and chat list, until they reply or approve here or you continue. Use it for waits outside this chat, such as a review or an answer elsewhere; your own questions and approvals already show who they wait on. person: a workspace member\'s name, email or id, or any name. reason: one short line, such as "review PR #2291". person null clears it.',
      inputSchema: {
        person: z
          .string()
          .trim()
          .min(1)
          .max(SESSION_WAITING_ON_PERSON_MAX_LENGTH)
          .nullable()
          .describe("Who the chat waits on; null clears it."),
        reason: z
          .string()
          .trim()
          .max(SESSION_WAITING_ON_REASON_MAX_LENGTH)
          .optional()
          .describe("What they need to do, in one short line."),
      },
    },
    async ({ person, reason }) => {
      await authorize();
      if (person === null) {
        await setSessionWaitingOn(deps, {
          workspaceId: grant.workspaceId,
          sessionId,
          turnId,
          waitingOn: null,
        });
        return json({ ok: true, waitingOn: null });
      }
      const member = await resolveMember(deps, grant.workspaceId, person).catch(() => null);
      const waitingOn = {
        person: (member?.label ?? person).slice(0, SESSION_WAITING_ON_PERSON_MAX_LENGTH),
        subjectId: member?.subjectId ?? null,
        reason: reason?.trim() || null,
      };
      await setSessionWaitingOn(deps, {
        workspaceId: grant.workspaceId,
        sessionId,
        turnId,
        waitingOn,
      });
      return json({
        ok: true,
        waitingOn,
        note: "Shown once this turn ends, until the person replies or you continue.",
      });
    },
  );

  server.registerTool(
    "session_links_add",
    {
      description:
        'Link something this chat works on, shown in its Linked panel with live status where Opengeni can read it: an issue, a pull request, a Slack thread, an App record or any URL. Pull requests you open with the GitHub tools are linked automatically. Adding the same URL again updates its title. wakeWhen, for a GitHub pull request: "merged" wakes this chat once when it merges, "release_published" once when its repository next publishes a release; then report back where the work started, such as the Slack thread.',
      inputSchema: {
        url: z.string().url().max(SESSION_LINK_URL_MAX_LENGTH),
        title: z.string().trim().min(1).max(SESSION_LINK_TITLE_MAX_LENGTH).optional(),
        kind: z
          .enum(SESSION_LINK_KINDS)
          .optional()
          .describe("Only when the URL does not show it, such as record for an App record."),
        wakeWhen: z.enum(["merged", "release_published"]).optional(),
      },
    },
    async ({ url, title, kind, wakeWhen }) => {
      await authorize();
      const wake = wakeWhen ? input.wake() : null;
      if (wakeWhen && !wake) {
        throw new ToolArgumentError(
          "wakeWhen needs automations with event triggers in this chat (scheduled_tasks_create and event_sources_list) and a GitHub event source in Automations. Link it without wakeWhen, or ask the person to add the GitHub event source.",
        );
      }
      const result = await addSessionLink(deps, {
        workspaceId: grant.workspaceId,
        sessionId,
        url,
        title,
        kind,
        addedBy: "agent",
      }).catch(linkError);
      if (!result) throw new ToolArgumentError("This chat is not available.");
      // The link stands even when the wake can't be set up; say why instead.
      let automation: unknown;
      let wakeNotSet: string | undefined;
      if (wake && wakeWhen) {
        try {
          // Validates the link kind before any GitHub read.
          sessionLinkWakeRequest(result.link, wakeWhen);
          const target = await input.wakeTarget(result.link);
          if (!target) {
            throw new ToolArgumentError(
              "The workspace's GitHub App can't read this repository, so its events can't wake this chat. A person installs the App on it in Settings.",
            );
          }
          if (wakeWhen === "merged" && target.state === "merged") {
            throw new ToolArgumentError(
              "This pull request is already merged; report back now instead of waiting.",
            );
          }
          automation = await wake(sessionLinkWakeRequest(result.link, wakeWhen, target.fullName));
        } catch (error) {
          if (!(error instanceof ToolArgumentError)) throw error;
          wakeNotSet = error.message;
        }
      }
      return json({
        ok: true,
        added: result.added,
        link: result.link,
        ...(automation !== undefined ? { wake: automation } : {}),
        ...(wakeNotSet ? { wakeNotSet } : {}),
      });
    },
  );

  server.registerTool(
    "session_links_remove",
    {
      description: "Remove a link from this chat's Linked panel, by its URL or id.",
      inputSchema: {
        url: z.string().max(SESSION_LINK_URL_MAX_LENGTH).optional(),
        id: z.string().max(64).optional(),
      },
    },
    async ({ url, id }) => {
      await authorize();
      if (!url && !id) throw new ToolArgumentError("Give the link's url or id.");
      const removed = await removeSessionLink(deps, {
        workspaceId: grant.workspaceId,
        sessionId,
        ...(url ? { url } : {}),
        ...(id ? { id } : {}),
      });
      const links = (await getSessionLinks(deps.db, grant.workspaceId, sessionId)) ?? [];
      return json({ ok: true, removed: removed === true, links: links.map((link) => link.url) });
    },
  );
}

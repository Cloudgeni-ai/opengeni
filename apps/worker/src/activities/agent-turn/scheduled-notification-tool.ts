import type { AttemptToolDefinition, AttemptToolScope } from "@opengeni/codemode";
import { NotificationKey, SessionNotificationPostedPayload } from "@opengeni/contracts";
import {
  getScheduledNotificationContext,
  getSessionTurnForAttempt,
  type Database,
} from "@opengeni/db";
import { appendAndPublishTurnEventsFenced } from "@opengeni/events";
import * as z from "zod/v4";

// Reuse the notification payload's bounds and rich-content validation, but
// never accept a recipient or sender from the agent on this self-owner path.
const Input = SessionNotificationPostedPayload.omit({
  body: true,
  replaced: true,
  recipientSubjectId: true,
  sender: true,
  undeliveredReason: true,
}).extend({
  key: NotificationKey.optional(),
  message: SessionNotificationPostedPayload.shape.body,
});

export async function createScheduledNotificationTools(input: {
  db: Database;
  bus: Parameters<typeof appendAndPublishTurnEventsFenced>[1];
  scope: AttemptToolScope;
}): Promise<AttemptToolDefinition[]> {
  const { db, bus, scope } = input;
  const context = await getScheduledNotificationContext(db, scope);
  if (!context) return [];
  return [
    {
      identity: { serverId: "opengeni", toolName: "notify_user" },
      modelName: "notify_user",
      codemodePath: ["opengeni", "notify_user"],
      title: "Notify schedule owner",
      description: [
        context.subjectId === null
          ? "This scheduled run has no human inbox recipient. Calls record a notification but return delivered: false; nobody receives an inbox or phone alert."
          : "Notify this scheduled run's owner in their inbox and, when configured, on their phone. The recipient is fixed by the accepted occurrence, even in another person's chat. No other recipient is allowed.",
        "Use sparingly for a result or blocker the owner needs to know about. Questions and approvals already alert them; do not duplicate those. Use a short title and message; facts and one external https link are optional. The notification links back here automatically, so do not add session links or secrets.",
        "Use a stable key: reposting updates the same item without another phone alert. Default urgency is normal; time_sensitive is only for something that cannot wait.",
      ].join(" "),
      inputSchema: z.toJSONSchema(Input, {
        io: "input",
        target: "draft-7",
      }) as AttemptToolDefinition["inputSchema"],
      source: "opengeni",
      approval: "none",
      execute: async (args, execution) => {
        const parsed = Input.parse(args);
        const turn = await getSessionTurnForAttempt(
          db,
          scope.workspaceId,
          scope.sessionId,
          scope.attemptId,
        );
        if (
          !turn ||
          turn.id !== scope.turnId ||
          turn.executionGeneration !== scope.executionGeneration
        ) {
          throw new Error("The notification no longer belongs to the active attempt.");
        }
        // Operation identity also deduplicates an exact retry when no key was supplied.
        const key = NotificationKey.parse(parsed.key ?? `n-${execution.operationId}`);
        const current = await getScheduledNotificationContext(db, { ...scope, key });
        if (
          !current ||
          current.runId !== context.runId ||
          current.subjectId !== context.subjectId
        ) {
          throw new Error("The scheduled notification recipient is no longer available.");
        }
        const { message, ...fields } = parsed;
        const payload = SessionNotificationPostedPayload.parse({
          ...fields,
          key,
          body: message,
          replaced: current.existing,
          ...(current.subjectId === null ? { undeliveredReason: "no_human_recipient" } : {}),
        });
        const appended = await appendAndPublishTurnEventsFenced(
          db,
          bus,
          scope.workspaceId,
          scope.sessionId,
          scope.turnId,
          scope.executionGeneration,
          scope.attemptId,
          [{ type: "session.notification.posted", payload }],
        );
        if (!appended.accepted) {
          throw new Error("The calling turn was replaced before the notification committed.");
        }
        // Projection is transactional but can deliberately refuse an event. Do
        // not report delivery merely because an event was appended.
        const projected = await getScheduledNotificationContext(db, { ...scope, key });
        if (current.subjectId !== null && !projected?.existing) {
          throw new Error(
            "The notification event was recorded but inbox delivery could not be confirmed. Retry with the same key.",
          );
        }
        return {
          isError: false,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                key,
                delivered: projected?.existing === true,
                ...(current.subjectId === null ? { undeliveredReason: "no_human_recipient" } : {}),
                updatedInPlace: current.existing,
              }),
            },
          ],
        };
      },
    },
  ];
}

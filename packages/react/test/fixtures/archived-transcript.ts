import type { ArchivedSessionImportEvent } from "@opengeni/contracts";
import type { SessionEvent } from "@opengeni/sdk";

export const ARCHIVED_WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
export const ARCHIVED_SESSION_ID = "22222222-2222-4222-8222-222222222222";
export const ARCHIVED_FILE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const firstTurn = "33333333-3333-4333-8333-333333333333";
const secondTurn = "44444444-4444-4444-8444-444444444444";

/** Sample embedded-host export, with already re-uploaded file IDs. */
export const archivedImportTranscript: ArchivedSessionImportEvent[] = [
  { type: "user.message", createdAt: "2024-03-01T08:00:00.000Z", turnId: firstTurn, payload: { text: "Summarize the attached migration plan.", resources: [{ kind: "file", fileId: ARCHIVED_FILE_ID }] } },
  { type: "turn.started", createdAt: "2024-03-01T08:00:01.000Z", turnId: firstTurn, payload: {} },
  { type: "goal.set", createdAt: "2024-03-01T08:00:02.000Z", payload: { actor: "api", text: "Prepare the customer migration" } },
  { type: "agent.message.completed", createdAt: "2024-03-01T08:00:03.000Z", turnId: firstTurn, payload: { messageId: "progress-1", phase: "commentary", text: "I’ll read the plan and compare the requirements." } },
  { type: "agent.toolCall.created", createdAt: "2024-03-01T08:00:04.000Z", turnId: firstTurn, payload: { id: "call-read-plan", name: "read_migration_plan", arguments: { fileId: ARCHIVED_FILE_ID }, display: { toolName: "read_migration_plan", title: "Read migration plan" } } },
  { type: "agent.toolCall.output", createdAt: "2024-03-01T08:00:05.000Z", turnId: firstTurn, payload: { id: "call-read-plan", output: { milestones: ["Re-upload files", "Import past conversations", "Switch the session proxy"], owner: "Support team" } } },
  { type: "agent.message.delta", createdAt: "2024-03-01T08:00:06.000Z", turnId: firstTurn, payload: { messageId: "answer-1", phase: "final_answer", text: "The migration " } },
  { type: "agent.message.completed", createdAt: "2024-03-01T08:00:07.000Z", turnId: firstTurn, payload: { messageId: "answer-1", phase: "final_answer", text: `The migration has three milestones: files, conversations, and the proxy.\n\n[Migration plan](artifact:${ARCHIVED_FILE_ID})` } },
  { type: "artifact.created", createdAt: "2024-03-01T08:00:07.100Z", turnId: firstTurn, payload: { fileId: ARCHIVED_FILE_ID, name: "migration-plan.pdf" } },
  { type: "turn.completed", createdAt: "2024-03-01T08:00:08.000Z", turnId: firstTurn, payload: { output: `The migration has three milestones: files, conversations, and the proxy.\n\n[Migration plan](artifact:${ARCHIVED_FILE_ID})` } },
  { type: "user.message", createdAt: "2024-03-01T08:02:00.000Z", turnId: secondTurn, payload: { text: "Will users still see their past chats? 日本語も保持してください。" } },
  { type: "turn.started", createdAt: "2024-03-01T08:02:01.000Z", turnId: secondTurn, payload: {} },
  { type: "agent.message.completed", createdAt: "2024-03-01T08:02:02.000Z", turnId: secondTurn, payload: { messageId: "answer-2", phase: "final_answer", text: "Yes. Their past conversations remain visible, including tool results and file links. 日本語もそのまま残ります。" } },
  { type: "goal.completed", createdAt: "2024-03-01T08:02:03.000Z", payload: { actor: "api", text: "Prepare the customer migration", evidence: "Migration plan reviewed" } },
  { type: "turn.completed", createdAt: "2024-03-01T08:02:04.000Z", turnId: secondTurn, payload: {} },
];

/** The existing event envelope, not an import-specific timeline projection. */
export function archivedTranscriptEvents(): SessionEvent[] {
  return archivedImportTranscript.map((event, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    workspaceId: ARCHIVED_WORKSPACE_ID,
    sessionId: ARCHIVED_SESSION_ID,
    sequence: index + 1,
    type: event.type,
    payload: event.payload,
    occurredAt: event.createdAt,
    turnId: event.turnId ?? null,
  }));
}
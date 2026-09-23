import { and, desc, eq, isNull } from "drizzle-orm";
import {
  CreateFeedbackRequest,
  Feedback,
  type FeedbackSubmissionResponse,
} from "@opengeni/contracts";
import { withWorkspaceSubjectRls, type Database } from "./database";
import { feedbackSubmissions, sessions, sessionTurns } from "./schema";
import { fromPostgresLosslessText } from "./lossless-json";

export class FeedbackConflictError extends Error {}
export class FeedbackTargetNotFoundError extends Error {}

function project(row: typeof feedbackSubmissions.$inferSelect): Feedback {
  return Feedback.parse({
    ...row,
    comment:
      row.comment === null ? null : fromPostgresLosslessText(row.comment, row.commentCodecVersion),
    createdAt: row.createdAt.toISOString(),
  });
}

export async function createFeedback(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    principalKind: string | null;
    request: CreateFeedbackRequest;
  },
): Promise<FeedbackSubmissionResponse> {
  const request = CreateFeedbackRequest.parse(input.request);
  return withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (tx) => {
    if (request.sessionId) {
      const [target] = await tx
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.workspaceId, input.workspaceId), eq(sessions.id, request.sessionId)))
        .for("key share");
      if (!target) throw new FeedbackTargetNotFoundError("Session not found");
      if (request.turnId) {
        const [turn] = await tx
          .select({ id: sessionTurns.id })
          .from(sessionTurns)
          .where(
            and(
              eq(sessionTurns.workspaceId, input.workspaceId),
              eq(sessionTurns.sessionId, request.sessionId),
              eq(sessionTurns.id, request.turnId),
            ),
          )
          .for("key share");
        if (!turn) throw new FeedbackTargetNotFoundError("Turn not found");
      }
    }
    const [created] = await tx
      .insert(feedbackSubmissions)
      .values({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        subjectId: input.subjectId,
        principalKind: input.principalKind,
        idempotencyKey: request.idempotencyKey,
        sessionId: request.sessionId ?? null,
        turnId: request.turnId ?? null,
        sentiment: request.sentiment ?? null,
        comment: request.comment ?? null,
        commentCodecVersion: request.comment === undefined ? null : 1,
      })
      .onConflictDoNothing({
        target: [
          feedbackSubmissions.workspaceId,
          feedbackSubmissions.subjectId,
          feedbackSubmissions.idempotencyKey,
        ],
      })
      .returning();
    if (created) return { feedback: project(created), replayed: false };
    const [existing] = await tx
      .select()
      .from(feedbackSubmissions)
      .where(
        and(
          eq(feedbackSubmissions.workspaceId, input.workspaceId),
          eq(feedbackSubmissions.subjectId, input.subjectId),
          eq(feedbackSubmissions.idempotencyKey, request.idempotencyKey),
        ),
      );
    if (!existing) throw new FeedbackConflictError("Feedback request key is unavailable");
    const feedback = project(existing);
    if (
      feedback.sessionId !== (request.sessionId ?? null) ||
      feedback.turnId !== (request.turnId ?? null) ||
      feedback.sentiment !== (request.sentiment ?? null) ||
      feedback.comment !== (request.comment ?? null)
    )
      throw new FeedbackConflictError("Feedback request key already used with a different payload");
    return { feedback, replayed: true };
  });
}

/** Exact scope: omitting sessionId returns general feedback only, never private-session rows. */
export async function listOwnFeedback(
  db: Database,
  input: {
    workspaceId: string;
    subjectId: string;
    sessionId?: string | undefined;
    limit?: number | undefined;
    includeTurns?: boolean | undefined;
  },
): Promise<Feedback[]> {
  return withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (tx) => {
    const rows = await tx
      .select()
      .from(feedbackSubmissions)
      .where(
        and(
          eq(feedbackSubmissions.workspaceId, input.workspaceId),
          eq(feedbackSubmissions.subjectId, input.subjectId),
          input.sessionId
            ? eq(feedbackSubmissions.sessionId, input.sessionId)
            : isNull(feedbackSubmissions.sessionId),
          input.includeTurns === false ? isNull(feedbackSubmissions.turnId) : undefined,
        ),
      )
      .orderBy(desc(feedbackSubmissions.createdAt), desc(feedbackSubmissions.id))
      .limit(Math.min(100, Math.max(1, input.limit ?? 50)));
    return rows.map(project);
  });
}

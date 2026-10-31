import { and, desc, eq, isNull } from "drizzle-orm";
import {
  CreateFeedbackRequest,
  Feedback,
  FeedbackContext,
  FeedbackScreenshot,
  type FeedbackSubmissionResponse,
} from "@opengeni/contracts";
import { withWorkspaceSubjectRls, type Database } from "./database";
import { feedbackSubmissions, sessionEventCursors, sessions, sessionTurns } from "./schema";
import { fromPostgresLosslessText } from "./lossless-json";

export class FeedbackConflictError extends Error {}
export class FeedbackTargetNotFoundError extends Error {}

/** A screenshot as stored on the row: its public metadata plus where the bytes are. */
export type StoredFeedbackScreenshot = FeedbackScreenshot & { objectKey: string };

/**
 * What the server records with a report, for whoever investigates it: the
 * server build that received it and, when the report names the chat in view
 * and its author can read that chat, the chat's state and latest turn at that
 * moment. Stored once with the report; never returned to clients.
 */
export interface FeedbackDiagnostics {
  server: { version?: string; revision?: string };
  session?: {
    id: string;
    status: string;
    visibility: string;
    lastSequence: number;
    latestTurn?: {
      id: string;
      status: string;
      model: string;
      reasoningEffort: string;
      createdAt: string;
      startedAt: string | null;
      finishedAt: string | null;
    };
  };
}

/** Object key for one screenshot. The digest makes a different image a different object. */
export function feedbackScreenshotObjectKey(input: {
  accountId: string;
  workspaceId: string;
  idempotencyKey: string;
  index: number;
  sha256: string;
}): string {
  return `feedback/${input.accountId}/${input.workspaceId}/${input.idempotencyKey}/${input.index}-${input.sha256}`;
}

function storedScreenshots(value: unknown): StoredFeedbackScreenshot[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = FeedbackScreenshot.safeParse(entry);
    const objectKey =
      entry && typeof entry === "object" && "objectKey" in entry ? entry.objectKey : undefined;
    return parsed.success && typeof objectKey === "string" ? [{ ...parsed.data, objectKey }] : [];
  });
}

/** Stable JSON for comparing a retried payload with the stored one. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value ?? null);
}

function project(row: typeof feedbackSubmissions.$inferSelect): Feedback {
  const context = row.context ? FeedbackContext.safeParse(row.context) : null;
  return Feedback.parse({
    ...row,
    comment:
      row.comment === null ? null : fromPostgresLosslessText(row.comment, row.commentCodecVersion),
    context: context?.success ? context.data : null,
    screenshots: storedScreenshots(row.screenshots).map(
      ({ objectKey: _objectKey, ...screenshot }) => screenshot,
    ),
    createdAt: row.createdAt.toISOString(),
  });
}

/**
 * Creates feedback. Screenshot bytes must already be in object storage under
 * {@link feedbackScreenshotObjectKey}; `screenshots` describes them in order.
 */
export async function createFeedback(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    principalKind: string | null;
    request: CreateFeedbackRequest;
    screenshots?: StoredFeedbackScreenshot[];
    /** The receiving server's version and deployment revision, when known. */
    server?: { version?: string | undefined; revision?: string | undefined };
  },
): Promise<FeedbackSubmissionResponse> {
  const request = CreateFeedbackRequest.parse(input.request);
  const screenshots = input.screenshots ?? [];
  if (screenshots.length !== (request.screenshots?.length ?? 0))
    throw new Error("Every feedback screenshot must be stored before the feedback is created");
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
    const diagnostics: FeedbackDiagnostics = {
      server: {
        ...(input.server?.version ? { version: input.server.version } : {}),
        ...(input.server?.revision ? { revision: input.server.revision } : {}),
      },
    };
    // The chat in view, read with the author's own access: a chat they cannot
    // read is simply not described.
    const inView = request.sessionId ?? request.context?.sessionId;
    if (inView) {
      const [session] = await tx
        .select({
          id: sessions.id,
          status: sessions.status,
          visibility: sessions.visibility,
          lastSequence: sessionEventCursors.lastSequence,
        })
        .from(sessions)
        .leftJoin(sessionEventCursors, eq(sessionEventCursors.sessionId, sessions.id))
        .where(and(eq(sessions.workspaceId, input.workspaceId), eq(sessions.id, inView)))
        .limit(1);
      if (session) {
        const [turn] = await tx
          .select({
            id: sessionTurns.id,
            status: sessionTurns.status,
            model: sessionTurns.model,
            reasoningEffort: sessionTurns.reasoningEffort,
            createdAt: sessionTurns.createdAt,
            startedAt: sessionTurns.startedAt,
            finishedAt: sessionTurns.finishedAt,
          })
          .from(sessionTurns)
          .where(
            and(
              eq(sessionTurns.workspaceId, input.workspaceId),
              eq(sessionTurns.sessionId, session.id),
            ),
          )
          .orderBy(desc(sessionTurns.position), desc(sessionTurns.createdAt))
          .limit(1);
        diagnostics.session = {
          id: session.id,
          status: session.status,
          visibility: session.visibility,
          lastSequence: session.lastSequence ?? 0,
          ...(turn
            ? {
                latestTurn: {
                  ...turn,
                  createdAt: turn.createdAt.toISOString(),
                  startedAt: turn.startedAt?.toISOString() ?? null,
                  finishedAt: turn.finishedAt?.toISOString() ?? null,
                },
              }
            : {}),
        };
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
        context: request.context ?? null,
        screenshots,
        diagnostics: diagnostics as unknown as Record<string, unknown>,
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
      feedback.comment !== (request.comment ?? null) ||
      canonical(existing.context) !== canonical(request.context ?? null) ||
      canonical(storedScreenshots(existing.screenshots).map((each) => each.sha256)) !==
        canonical(screenshots.map((each) => each.sha256))
    )
      throw new FeedbackConflictError("Feedback request key already used with a different payload");
    return { feedback, replayed: true };
  });
}

/** One of the author's own screenshots, or null when it is not theirs or does not exist. */
export async function getOwnFeedbackScreenshot(
  db: Database,
  input: { workspaceId: string; subjectId: string; feedbackId: string; index: number },
): Promise<StoredFeedbackScreenshot | null> {
  return withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (tx) => {
    const [row] = await tx
      .select({ screenshots: feedbackSubmissions.screenshots })
      .from(feedbackSubmissions)
      .where(
        and(
          eq(feedbackSubmissions.workspaceId, input.workspaceId),
          eq(feedbackSubmissions.subjectId, input.subjectId),
          eq(feedbackSubmissions.id, input.feedbackId),
        ),
      );
    return storedScreenshots(row?.screenshots).find((each) => each.index === input.index) ?? null;
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

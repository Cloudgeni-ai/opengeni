import { createHash } from "node:crypto";
import {
  CreateFeedbackRequest,
  FEEDBACK_SCREENSHOT_MAX_BYTES,
  type FeedbackScreenshotUpload,
} from "@opengeni/contracts";
import {
  requireAccessGrant,
  requireSessionAuthorization,
  withResolvedSessionAuthorization,
  SessionAuthorizationDeniedError,
  SessionAuthorizationUnavailableError,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  createFeedback,
  feedbackScreenshotObjectKey,
  getOwnFeedbackScreenshot,
  listOwnFeedback,
  FeedbackConflictError,
  FeedbackTargetNotFoundError,
  type StoredFeedbackScreenshot,
} from "@opengeni/db";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { parseRequestBody, parseRequestQuery } from "../http/request-body";
import { userContentResponseHeaders } from "../http/user-content";

/** The image really is the type it claims: JPEG and PNG signatures. */
function matchesSignature(bytes: Uint8Array, contentType: string): boolean {
  if (contentType === "image/jpeg")
    return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return bytes.length > png.length && png.every((byte, index) => bytes[index] === byte);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Puts each screenshot in object storage before the feedback row exists. Keys are
 * create-only and content-addressed, so retrying the same report writes nothing new.
 */
async function storeScreenshots(
  deps: ApiRouteDeps,
  input: { accountId: string; workspaceId: string; idempotencyKey: string },
  uploads: readonly FeedbackScreenshotUpload[],
): Promise<StoredFeedbackScreenshot[]> {
  if (uploads.length === 0) return [];
  const storage = deps.objectStorage;
  if (!storage?.putObjectIfAbsent)
    throw new HTTPException(503, { message: "Feedback screenshots need object storage" });
  const decoded = uploads.map((upload, index) => {
    const bytes = Uint8Array.from(Buffer.from(upload.base64, "base64"));
    if (bytes.byteLength > FEEDBACK_SCREENSHOT_MAX_BYTES)
      throw new HTTPException(413, { message: `Screenshot ${index + 1} is too large` });
    if (!matchesSignature(bytes, upload.contentType))
      throw new HTTPException(400, {
        message: `Screenshot ${index + 1} is not a valid ${upload.contentType} image`,
      });
    return { bytes, contentType: upload.contentType, index };
  });
  const stored: StoredFeedbackScreenshot[] = [];
  for (const { bytes, contentType, index } of decoded) {
    const sha256 = sha256Hex(bytes);
    const objectKey = feedbackScreenshotObjectKey({ ...input, index, sha256 });
    await storage.putObjectIfAbsent({ key: objectKey, contentType, body: bytes, sha256 });
    stored.push({ index, contentType, sizeBytes: bytes.byteLength, sha256, objectKey });
  }
  return stored;
}

export function registerFeedbackRoutes(app: Hono, deps: ApiRouteDeps): void {
  app.post("/v1/workspaces/:workspaceId/feedback", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    await requireAccessGrant(c, deps, workspaceId, "sessions:create");
    const parsed = parseRequestBody(CreateFeedbackRequest, await c.req.json().catch(() => null), {
      status: 400,
      message: "Invalid feedback",
    });
    // Agent turns must not manufacture user satisfaction evidence. Product SDK
    // credentials are allowed but retain their own authenticated author/kind.
    if (
      grant.principalKind === "agent_attempt" ||
      grant.metadata?.["turnId"] !== undefined ||
      grant.metadata?.["attemptId"] !== undefined
    )
      throw new HTTPException(403, { message: "Agent attempts cannot submit feedback" });
    try {
      const screenshots = await storeScreenshots(
        deps,
        { accountId: grant.accountId, workspaceId, idempotencyKey: parsed.idempotencyKey },
        parsed.screenshots ?? [],
      );
      const save = () =>
        createFeedback(deps.db, {
          accountId: grant.accountId,
          workspaceId,
          subjectId: grant.subjectId,
          principalKind: grant.principalKind ?? null,
          request: parsed,
          screenshots,
        });
      let result;
      if (parsed.sessionId) {
        await requireAccessGrant(c, deps, workspaceId, "sessions:read");
        const authorization = await requireSessionAuthorization(deps, grant, {
          sessionId: parsed.sessionId,
          operation: "session.feedback.write",
          surface: "http",
        });
        result = authorization
          ? await withResolvedSessionAuthorization(authorization, save)
          : await save();
      } else result = await save();
      c.header("cache-control", "private, no-store");
      return c.json(result, result.replayed ? 200 : 201);
    } catch (error) {
      throw feedbackHttpError(error);
    }
  });
  app.get("/v1/workspaces/:workspaceId/feedback", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    const query = parseRequestQuery(
      z.object({
        sessionId: z.string().uuid().optional(),
        includeTurns: z
          .enum(["true", "false"])
          .default("true")
          .transform((value) => value === "true"),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      }),
      c.req.query(),
      { status: 400, message: "Invalid feedback query" },
    );
    try {
      const read = () =>
        listOwnFeedback(deps.db, { workspaceId, subjectId: grant.subjectId, ...query });
      let feedback;
      if (query.sessionId) {
        await requireAccessGrant(c, deps, workspaceId, "sessions:read");
        const authorization = await requireSessionAuthorization(deps, grant, {
          sessionId: query.sessionId,
          operation: "session.read",
          surface: "http",
        });
        feedback = authorization
          ? await withResolvedSessionAuthorization(authorization, read)
          : await read();
      } else feedback = await read();
      c.header("cache-control", "private, no-store");
      return c.json({ feedback });
    } catch (error) {
      throw feedbackHttpError(error);
    }
  });
  // The author's own screenshot bytes. Session-linked feedback stays behind the
  // session's visibility rules through row-level security.
  app.get("/v1/workspaces/:workspaceId/feedback/:feedbackId/screenshots/:index", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    const params = z
      .object({ feedbackId: z.string().uuid(), index: z.coerce.number().int().min(0).max(9) })
      .safeParse({ feedbackId: c.req.param("feedbackId"), index: c.req.param("index") });
    if (!params.success) throw new HTTPException(404, { message: "Screenshot not found" });
    const screenshot = await getOwnFeedbackScreenshot(deps.db, {
      workspaceId,
      subjectId: grant.subjectId,
      ...params.data,
    });
    const object = screenshot
      ? await deps.objectStorage?.getObjectBytes(screenshot.objectKey)
      : null;
    if (!screenshot || !object) throw new HTTPException(404, { message: "Screenshot not found" });
    return c.body(Uint8Array.from(object.bytes).buffer, 200, {
      ...userContentResponseHeaders(screenshot.contentType),
      "content-type": screenshot.contentType,
      "cache-control": "private, no-store",
    });
  });
}
function feedbackHttpError(error: unknown): Error {
  if (error instanceof FeedbackConflictError)
    return new HTTPException(409, { message: error.message });
  if (
    error instanceof FeedbackTargetNotFoundError ||
    error instanceof SessionAuthorizationDeniedError
  )
    return new HTTPException(404, { message: "Feedback target not found" });
  if (error instanceof SessionAuthorizationUnavailableError)
    return new HTTPException(503, { message: "Session authorization unavailable" });
  if (error instanceof Error) return error;
  return new Error("Feedback request failed");
}

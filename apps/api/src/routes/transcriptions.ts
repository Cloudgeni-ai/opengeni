import {
  resolveWorkspaceVoiceInputEnabled,
  type TranscribeAudioResponse,
} from "@opengeni/contracts";
import { type ApiRouteDeps, requireAccessGrant, TranscriptionServiceError } from "@opengeni/core";
import { getWorkspace } from "@opengeni/db";
import type { Hono } from "hono";
import { registerResumableTranscriptionRoutes } from "./transcription-recordings";

export function registerTranscriptionRoutes(app: Hono, deps: ApiRouteDeps): void {
  registerResumableTranscriptionRoutes(app, deps);
  app.post("/v1/workspaces/:workspaceId/transcriptions", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:create");
    const workspace = await getWorkspace(deps.db, workspaceId);
    if (!workspace) return c.json({ code: "not_found" }, 404);
    if (resolveWorkspaceVoiceInputEnabled(workspace.settings) === false) {
      return c.json({ code: "policy_blocked" }, 403);
    }
    const service = deps.transcription;
    if (!service || !(await service.available())) {
      return c.json({ code: "unavailable" }, 503);
    }
    try {
      const body = await audioRequest(c.req.raw, service.limits().maxSizeBytes);
      const result = await service.transcribe({
        workspaceId,
        accountId: grant.accountId,
        audio: body.audio,
        mimeType: body.mimeType,
        durationSeconds: body.durationSeconds,
        signal: c.req.raw.signal,
        requestId: c.req.header("x-opengeni-correlation-id") ?? crypto.randomUUID(),
      });
      const response: TranscribeAudioResponse = {
        text: result.text,
        languages: result.languages,
      };
      return c.json(response);
    } catch (error) {
      if (error instanceof TranscriptionServiceError) {
        return c.json({ code: error.code }, error.status as never);
      }
      if (isAbort(error)) return c.json({ code: "cancelled" }, 499 as never);
      return c.json({ code: "unknown" }, 500);
    }
  });
}

async function audioRequest(
  request: Request,
  maxSizeBytes: number,
): Promise<{ audio: Uint8Array; mimeType: string; durationSeconds?: number }> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxSizeBytes + 64 * 1024) {
    throw new TranscriptionServiceError({
      code: "too_large",
      message: "Audio is too large.",
    });
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.toLowerCase().startsWith("multipart/form-data")) {
    const form = await request.formData();
    const audio = form.get("audio");
    if (!(audio instanceof File)) {
      throw new TranscriptionServiceError({
        code: "invalid_audio",
        message: "Audio file is required.",
      });
    }
    if (audio.size > maxSizeBytes) {
      throw new TranscriptionServiceError({
        code: "too_large",
        message: "Audio is too large.",
      });
    }
    const durationSeconds = durationValue(stringValue(form.get("durationSeconds")));
    return {
      audio: new Uint8Array(await audio.arrayBuffer()),
      mimeType: stringValue(form.get("mimeType")) ?? audio.type,
      ...(durationSeconds === undefined ? {} : { durationSeconds }),
    };
  }
  const mimeType = contentType.split(";", 1)[0]?.trim() ?? "";
  if (!mimeType.toLowerCase().startsWith("audio/")) {
    throw new TranscriptionServiceError({
      code: "not_supported",
      message: "Unsupported audio format.",
    });
  }
  const durationSeconds = durationValue(request.headers.get("x-opengeni-audio-duration-seconds"));
  return {
    audio: await readBounded(request.body, maxSizeBytes, request.signal),
    mimeType,
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
  };
}

async function readBounded(
  body: ReadableStream<Uint8Array> | null,
  maxSizeBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (!body)
    throw new TranscriptionServiceError({
      code: "invalid_audio",
      message: "Audio is required.",
    });
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxSizeBytes) {
        await reader.cancel();
        throw new TranscriptionServiceError({
          code: "too_large",
          message: "Audio is too large.",
        });
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const audio = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    audio.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return audio;
}

function durationValue(value: string | null | undefined): number | undefined {
  if (value == null || value.trim() === "") return undefined;
  const duration = Number(value);
  if (!Number.isFinite(duration)) {
    throw new TranscriptionServiceError({
      code: "invalid_audio",
      message: "Invalid audio duration.",
    });
  }
  return duration;
}

function stringValue(value: FormDataEntryValue | null): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

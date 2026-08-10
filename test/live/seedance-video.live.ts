import { describe, expect, test } from "bun:test";
import { getSettings } from "@opengeni/config";
import type { CanonicalVideoGenerationRequest } from "@opengeni/core";
import { createHash, randomUUID } from "node:crypto";
import {
  GatewayVideoApiError,
  getGatewayVideoGenerationStatus,
  startGatewayVideoGeneration,
} from "../../apps/worker/src/activities/gateway-video-generation";
import { downloadGeneratedVideoToVerifiedTemp } from "../../apps/worker/src/activities/video-output-retention";

const apiKey = process.env.OPENGENI_VERCEL_AI_GATEWAY_API_KEY?.trim() ?? "";
const live =
  process.env.OPENGENI_ENABLE_LIVE_TESTS === "true" &&
  process.env.OPENGENI_LIVE_VIDEO_ACKNOWLEDGE_PAID_CALL === "true" &&
  apiKey.length > 0;

describe("live Seedance video generation", () => {
  test.skipIf(!live)(
    "generates and validates one 4-second 480p H.264 MP4",
    async () => {
      const request: CanonicalVideoGenerationRequest = {
        schemaVersion: 1,
        modelId: "bytedance/seedance-2.5",
        prompt:
          "A single white paper boat glides slowly across a calm blue pond at sunrise, fixed camera, natural motion.",
        sourceMode: "text",
        references: [],
        durationSeconds: 4,
        aspectRatio: "16:9",
        resolution: "480p",
        generateAudio: true,
      };
      const requestedIdempotencyHex = process.env.OPENGENI_LIVE_VIDEO_IDEMPOTENCY_HEX;
      const idempotencyHex = /^[0-9a-f]{48}$/u.test(requestedIdempotencyHex ?? "")
        ? requestedIdempotencyHex!
        : createHash("sha256").update(`live-seedance:${randomUUID()}`).digest("hex").slice(0, 48);
      const idempotencyKey = `ogvid_${idempotencyHex}`;
      let started: Awaited<ReturnType<typeof startGatewayVideoGeneration>> | null = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          started = await startGatewayVideoGeneration({
            apiKey,
            request,
            idempotencyKey,
            referenceGrants: [],
          });
          break;
        } catch (error) {
          if (!(error instanceof GatewayVideoApiError) || !error.retryable || attempt === 2) {
            throw error;
          }
          await Bun.sleep(3_000);
        }
      }
      if (!started) throw new Error("Seedance live canary did not start");

      const deadline = Date.now() + 12 * 60_000;
      let completed: Extract<
        Awaited<ReturnType<typeof getGatewayVideoGenerationStatus>>,
        { status: "completed" }
      > | null = null;
      while (Date.now() < deadline) {
        let status: Awaited<ReturnType<typeof getGatewayVideoGenerationStatus>>;
        try {
          status = await getGatewayVideoGenerationStatus({
            apiKey,
            modelId: request.modelId,
            providerJobId: started.providerJobId,
          });
        } catch (error) {
          if (error instanceof GatewayVideoApiError && error.retryable) {
            await Bun.sleep(5_000);
            continue;
          }
          throw error;
        }
        if (status.status === "error") throw new Error(status.publicReason);
        if (status.status === "completed") {
          completed = status;
          break;
        }
        await Bun.sleep(5_000);
      }
      if (!completed) throw new Error("Seedance live canary timed out");

      const downloaded = await downloadGeneratedVideoToVerifiedTemp({
        url: completed.outputUrl,
        mediaType: completed.mediaType,
        settings: getSettings(),
        expectedDurationSeconds: request.durationSeconds,
      });
      try {
        expect(downloaded.temp.sizeBytes).toBeGreaterThan(0);
        expect(downloaded.temp.sha256).toMatch(/^[0-9a-f]{64}$/u);
        expect(downloaded.facts.videoCodec).toBe("h264");
        expect(downloaded.facts.audioCodec).toBe("aac");
        expect(downloaded.facts.hasAudio).toBe(true);
        expect(downloaded.facts.durationSeconds).toBeGreaterThan(0);
      } finally {
        await downloaded.temp.cleanup();
      }
    },
    15 * 60_000,
  );
});

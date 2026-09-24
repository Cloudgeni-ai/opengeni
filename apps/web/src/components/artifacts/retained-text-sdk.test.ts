import { expect, test } from "bun:test";
import { OpenGeniClient } from "../../../../../packages/sdk/src/artifact-client";
import { OPENGENI_API_CONTRACT_REVISION, type RetainedArtifactReference } from "@opengeni/sdk";
import { decodeRetainedText } from "./retained-text-preview-policy";

test("text preview SDK transport authenticates ranges and rejects corrupt or cross-workspace receipts", async () => {
  const workspaceId = "11111111-1111-4111-8111-111111111111";
  const artifactId = "22222222-2222-4222-8222-222222222222";
  const bytes = new TextEncoder().encode("verified source\n");
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const artifact: RetainedArtifactReference = {
    available: true,
    artifactId,
    kind: "file",
    contentType: "text/plain",
    originalBytes: bytes.length,
    sha256,
    retainedAt: "2026-09-24T00:00:00Z",
    retention: { policy: "workspace_file", expiresAt: null },
    retrieval: {
      method: "GET",
      path: `/v1/workspaces/${workspaceId}/artifacts/${artifactId}/content`,
      acceptRanges: "bytes",
      maxRangeBytes: 1048576,
    },
  };
  let corrupt = false;
  let denied = false;
  let calls = 0;
  const client = new OpenGeniClient({
    baseUrl: "https://fixture.invalid",
    headers: { "x-opengeni-access-key": "fixture-only" },
    fetch: (async (_url, init) => {
      calls++;
      const headers = new Headers(init?.headers);
      expect(headers.get("x-opengeni-access-key")).toBe("fixture-only");
      if (denied) return new Response("Denied", { status: 403 });
      const [, from, to] = /^bytes=(\d+)-(\d+)$/.exec(headers.get("range") ?? "")!;
      const start = Number(from),
        end = Number(to);
      const chunk = bytes.slice(start, end + 1);
      if (corrupt) chunk[0] = 0;
      return new Response(chunk, {
        status: 206,
        headers: {
          "x-opengeni-api-contract": OPENGENI_API_CONTRACT_REVISION,
          "accept-ranges": "bytes",
          "content-type": "text/plain",
          "content-length": String(chunk.length),
          "content-range": `bytes ${start}-${end}/${bytes.length}`,
        },
      });
    }) as typeof fetch,
  });
  expect(
    decodeRetainedText((await client.downloadRetainedArtifact(workspaceId, artifact)).bytes),
  ).toBe("verified source\n");
  expect(calls).toBe(1);
  corrupt = true;
  await expect(client.downloadRetainedArtifact(workspaceId, artifact)).rejects.toThrow(
    "checksum mismatch",
  );
  const before = calls;
  await expect(
    client.downloadRetainedArtifact("33333333-3333-4333-8333-333333333333", artifact),
  ).rejects.toThrow("receipt is invalid");
  expect(calls).toBe(before);
  denied = true;
  await expect(client.downloadRetainedArtifact(workspaceId, artifact)).rejects.toMatchObject({
    status: 403,
  });
  expect(calls).toBe(before + 1);
});

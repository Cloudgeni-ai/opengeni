import { useSyncExternalStore } from "react";
import { OpenGeniClient } from "@opengeni/sdk";
import { OPENGENI_API_CONTRACT_REVISION, type RetainedArtifactReference } from "@opengeni/sdk";
export const workspaceId = "11111111-1111-4111-8111-111111111111";
export const artifactId = "22222222-2222-4222-8222-222222222222";
const state = new URLSearchParams(location.search).get("state") ?? "patch";
const sample =
  "diff --git a/docs/integration.md b/docs/integration.md\n--- a/docs/integration.md\n+++ b/docs/integration.md\n@@ -1,3 +1,4 @@\n # Integration guidance\n-Download the artifact to read the proposed changes.\n+Read the proposed changes in the artifact panel.\n+Download remains available when you need the original file.\n Keep native documents as the report delivery path.\n";
const text =
  state === "html"
    ? '<script>alert("must remain inert")</script>\n<h1>This is source, not an HTML page.</h1>'
    : sample;
const bytes =
  state === "binary"
    ? new Uint8Array([65, 0, 66])
    : state === "encoding"
      ? new Uint8Array([255, 254, 65])
      : new TextEncoder().encode(text);
const digest = await crypto.subtle.digest("SHA-256", bytes);
const sha256 = Array.from(new Uint8Array(digest), (value) =>
  value.toString(16).padStart(2, "0"),
).join("");
export const filename =
  state === "html"
    ? "example.html"
    : state === "unsupported"
      ? "archive.zip"
      : "ope551-integration-docs.patch";
export const artifact: RetainedArtifactReference = {
  available: true,
  artifactId,
  kind: "file",
  contentType: state === "unsupported" ? "application/zip" : "application/octet-stream",
  originalBytes: state === "large" ? 524288 : bytes.length,
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
let calls = 0;
Object.assign(window, { previewCalls: () => calls });
// Real SDK range/checksum path; only HTTP responses and metadata are fixtures.
const transport = new OpenGeniClient({
  baseUrl: "https://fixture.invalid",
  headers: { "x-opengeni-access-key": "fixture-only" },
  fetch: (async (_input, init) => {
    calls++;
    if (new Headers(init?.headers).get("x-opengeni-access-key") !== "fixture-only")
      throw new Error("Missing fixture auth");
    if (state === "loading")
      return new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        ),
      );
    if (state === "error" && calls === 1) return new Response("Denied", { status: 403 });
    const content = bytes.slice();
    if (state === "checksum") content[0] = 0;
    return new Response(content, {
      status: 206,
      headers: {
        "x-opengeni-api-contract": OPENGENI_API_CONTRACT_REVISION,
        "accept-ranges": "bytes",
        "content-type": artifact.contentType,
        "content-length": String(content.length),
        "content-range": `bytes 0-${content.length - 1}/${content.length}`,
      },
    });
  }) as typeof fetch,
});
const client = {
  getRetainedArtifact: async () => artifact,
  getFile: async () => ({ id: artifactId, workspaceId, filename }),
  downloadRetainedArtifact: transport.downloadRetainedArtifact.bind(transport),
};
let context = { client, accessKeyVersion: 0 };
const listeners = new Set<() => void>();
export function replaceFixtureContext(next: typeof context) {
  context = next;
  listeners.forEach((fn) => fn());
}
export function useAppContext() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    () => context,
  );
}

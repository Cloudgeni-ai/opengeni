import { expect, test } from "bun:test";
import { OpenGeniApiError } from "../src/errors";
import { parseOpenGeniLink, resolveOpenGeniLinkTarget } from "../src/message-links";
import type { OpenGeniClient } from "../src/client";

const UUID = "22222222-2222-4222-8222-222222222222";
const WS = "11111111-1111-4111-8111-111111111111";
const reference = parseOpenGeniLink(`artifact:${UUID}`)!;

function clientFor(kind: "file" | "site" = "file", error?: Error) {
  const calls: unknown[] = [];
  const client: Pick<OpenGeniClient, "resolveArtifactLink"> = {
    resolveArtifactLink: async (...args) => {
      calls.push(args);
      if (error) throw error;
      return { kind, artifactId: args[1] };
    },
  };
  return { client, calls };
}

test("UUID files use one exact lookup with session and cancellation context", async () => {
  const { client, calls } = clientFor();
  const options = { sessionId: UUID, signal: new AbortController().signal };
  expect(await resolveOpenGeniLinkTarget(client, reference, WS, options)).toEqual({
    kind: "file",
    fileId: UUID,
    workspaceId: WS,
  });
  expect(calls).toEqual([[WS, UUID, options]]);
});

test("UUID Sites use the same exact lookup, not sequential kind probes", async () => {
  const { client, calls } = clientFor("site");
  expect(await resolveOpenGeniLinkTarget(client, reference, WS)).toEqual({
    kind: "site",
    artifactId: UUID,
    workspaceId: WS,
  });
  expect(calls).toEqual([[WS, UUID, {}]]);
});

test("permission, network, and server errors never turn into another artifact kind", async () => {
  for (const error of [
    new OpenGeniApiError(404, "Not found"),
    new OpenGeniApiError(403, "Forbidden"),
    new OpenGeniApiError(503, "Unavailable"),
    new Error("Network error"),
  ]) {
    const { client, calls } = clientFor("file", error);
    await expect(resolveOpenGeniLinkTarget(client, reference, WS)).rejects.toBe(error);
    expect(calls).toHaveLength(1);
  }
});

test("native editable IDs and legacy typed routes do not need metadata lookup", async () => {
  const { client, calls } = clientFor("file", new Error("must not read"));
  for (const href of [
    "artifact:0123456789abcdef0123456789abcdef",
    `/workspaces/${WS}/artifacts/${UUID}`,
    `/workspaces/${WS}/artifacts/files/${UUID}`,
    `/workspaces/${WS}/artifacts/editable/0123456789abcdef0123456789abcdef`,
    `session:${UUID}`,
  ]) {
    const target = parseOpenGeniLink(href)!;
    expect(await resolveOpenGeniLinkTarget(client, target, "other-workspace")).toBe(target);
  }
  expect(calls).toEqual([]);
});

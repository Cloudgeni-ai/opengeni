import { createAttemptToolEnvironment } from "../packages/codemode/src/index.ts";
import { OPENGENI_API_CONTRACT_REVISION } from "../packages/contracts/src/index.ts";
import { strict as assert } from "node:assert";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const image = process.argv[2];
const binary = process.argv[3];
if (!image || !binary)
  throw new Error(
    "Usage: bun scripts/test-codemode-image.ts IMAGE ABSOLUTE_NATIVE_BINARY [receipts]. Linux Docker host only; uses a loopback owned fixture, never a deployment.",
  );
const scope = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  sessionId: "33333333-3333-4333-8333-333333333333",
  turnId: "44444444-4444-4444-8444-444444444444",
  attemptId: "55555555-5555-4555-8555-555555555555",
  executionGeneration: 1,
};
const identity = { serverId: "docs", toolName: "search" };
const catalog = createAttemptToolEnvironment({
  scope,
  generation: 1,
  definitions: [
    {
      identity,
      modelName: "docs__search",
      inputSchema: { type: "object" },
      source: "mcp",
      approval: "none",
      execute: async () => ({ content: [] }),
    },
  ],
}).catalog;
let posts = 0;
let mode = "completed";
let lastId = "";
let denyRead = false;
let losePostAcknowledgement = false;
let activeClient = "";
const requests: string[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    assert.equal(req.headers.get("authorization"), "Bearer owned-fixture");
    // The native client supports older deployments whose Codemode routes were
    // contract-guarded. Current JS/CLI clients use the attempt protocol directly.
    if (activeClient === "native")
      assert.equal(req.headers.get("x-opengeni-api-contract"), OPENGENI_API_CONTRACT_REVISION);
    requests.push(req.method + " " + new URL(req.url).pathname);
    if (denyRead)
      return Response.json({ error: { message: "fixture access denied" } }, { status: 403 });
    if (new URL(req.url).pathname.endsWith("/catalog")) return Response.json(catalog);
    const now = new Date().toISOString();
    if (req.method === "POST") {
      const body = await req.json();
      lastId = body.operationId;
      posts++;
      if (losePostAcknowledgement) {
        losePostAcknowledgement = false;
        // Simulate a committed operation whose acknowledgement is unavailable.
        return Response.json(
          { error: { message: "lost acknowledgement", outcomeUnknown: true } },
          { status: 503 },
        );
      }
    }
    const operation = {
      version: 1,
      operationId: lastId,
      ...scope,
      catalogDigest: catalog.digest,
      requestDigest: "a".repeat(64),
      identity,
      arguments: {},
      caller: { kind: "codemode", subjectId: "agent:fixture" },
      state: mode,
      result: mode === "completed" ? { content: [{ type: "text", text: "fixture-ok" }] } : null,
      errorCode: mode === "completed" ? null : "tool_outcome_unknown",
      errorMessage: mode === "completed" ? null : "owned fixture uncertain outcome",
      createdAt: now,
      claimedAt: now,
      executionStartedAt: now,
      completedAt: now,
      updatedAt: now,
    };
    return Response.json(req.method === "POST" ? { dispatch: "terminal", operation } : operation);
  },
});
const dir = await mkdtemp(join(tmpdir(), "codemode-owned-fixture-"));
await chmod(dir, 0o700);
await writeFile(join(dir, "token"), "owned-fixture", { mode: 0o600 });
async function run(client: string, auth: string, args?: string[]) {
  activeClient = client;
  const cmd = [
    "docker",
    "run",
    "--rm",
    "--network",
    "host",
    "--entrypoint",
    client === "js" ? "bun" : client === "cli" ? "/usr/local/bin/ogtool" : "/native",
    "--mount",
    `type=bind,source=${dir},target=/fixture,readonly`,
    "--mount",
    `type=bind,source=${binary},target=/native,readonly`,
    "-e",
    `OPENGENI_CODEMODE_URL=http://127.0.0.1:${server.port}/codemode`,
    "-e",
    auth === "direct"
      ? "OPENGENI_CODEMODE_TOKEN=owned-fixture"
      : "OPENGENI_CODEMODE_TOKEN_FILE=/fixture/token",
    ...(auth === "direct" ? ["-e", "OPENGENI_CODEMODE_TOKEN_FILE=/unreadable/stale-pointer"] : []),
    image,
    ...(args ??
      (client === "js"
        ? [
            "-e",
            'import {tools} from "@opengeni/codemode"; console.log(JSON.stringify(await tools.docs.search({})));',
          ]
        : client === "cli"
          ? ["call", "docs.search", "{}"]
          : ["codemode", "call", "docs.search", "{}"])),
  ];
  const child = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { out, err, exit };
}
try {
  for (const auth of ["direct", "file"])
    for (const client of ["js", "cli", "native"]) {
      const before = posts;
      const r = await run(client, auth);
      assert.equal(r.exit, 0, r.err);
      assert.match(r.out, /fixture-ok/);
      assert.equal(posts, before + 1);
      console.log(JSON.stringify({ client, auth, status: "passed" }));
    }
  if (process.argv[4] === "receipts") {
    for (const client of ["js", "cli", "native"]) {
      losePostAcknowledgement = true;
      const before = posts;
      const beforeRequests = requests.length;
      const recovered = await run(client, "direct");
      assert.equal(recovered.exit, 0, recovered.err);
      assert.match(recovered.out, /fixture-ok/);
      assert.equal(posts, before + 1);
      assert.deepEqual(requests.slice(beforeRequests), [
        "GET /codemode/catalog",
        "POST /codemode/calls",
        "GET /codemode/calls/" + lastId,
      ]);
    }
    mode = "outcome_unknown";
    const before = posts;
    const r = await run("native", "direct");
    assert.notEqual(r.exit, 0);
    const receipt = JSON.parse(r.err);
    assert.equal(receipt.error.operationId, lastId);
    assert.equal(receipt.error.state, "outcome_unknown");
    assert.equal(posts, before + 1);
    assert.equal(r.out.trim(), "");
    const beforeRead = requests.length;
    const read = await run("native", "direct", ["codemode", "read", lastId]);
    assert.equal(read.exit, 0, read.err);
    assert.equal(JSON.parse(read.out).operation.state, "outcome_unknown");
    assert.equal(posts, before + 1);
    assert.deepEqual(requests.slice(beforeRead), ["GET /codemode/calls/" + lastId]);
    denyRead = true;
    const denied = await run("native", "direct", ["codemode", "read", lastId]);
    assert.equal(denied.exit, 1);
    const error = JSON.parse(denied.err).error;
    assert.equal(error.operationId, lastId);
    assert.equal(error.state, null);
    assert.match(error.message, /403/);
    assert.equal(posts, before + 1);
    const beforeInvalid = requests.length;
    const invalid = await run("native", "direct", ["codemode", "read", "../calls"]);
    assert.notEqual(invalid.exit, 0);
    assert.equal(requests.length, beforeInvalid);
    console.log(
      JSON.stringify({
        client: "native",
        test: "uncertain receipt and read without resubmission",
        status: "passed",
      }),
    );
  }
} finally {
  server.stop(true);
  await rm(dir, { recursive: true, force: true });
}

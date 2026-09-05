import { createAttemptToolEnvironment } from "@opengeni/codemode";

// Deterministic local transport fixture: measures actual CLI stdout, not a
// hand-written approximation of its projection. No live credentials are used.
const toolCount = 200;
const catalog = createAttemptToolEnvironment({
  scope: {
    accountId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    sessionId: "33333333-3333-4333-8333-333333333333",
    turnId: "44444444-4444-4444-8444-444444444444",
    attemptId: "55555555-5555-4555-8555-555555555555",
    executionGeneration: 1,
  },
  generation: 1,
  createdAt: new Date("2026-09-05T00:00:00.000Z"),
  definitions: Array.from({ length: toolCount }, (_, index) => ({
    identity: { serverId: "fixture", toolName: `search_${index}` },
    modelName: `fixture__search_${index}`,
    description: "Search bounded records by query and return matching results.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to search for.", maxLength: 1600 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        cursor: { type: "string", maxLength: 512 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
            properties: { id: { type: "string" }, title: { type: "string" } },
          },
        },
        nextCursor: { type: "string" },
      },
    },
    source: "mcp",
    approval: "none" as const,
    execute: async () => ({ content: [] }),
  })),
}).catalog;
const server = Bun.serve({
  port: 0,
  fetch(request) {
    if (request.headers.get("authorization") !== "Bearer benchmark-fixture") {
      return new Response(null, { status: 401 });
    }
    return new URL(request.url).pathname.endsWith("/catalog")
      ? Response.json(catalog)
      : new Response(null, { status: 404 });
  },
});
try {
  const commands = process.argv.includes("--baseline")
    ? [["list"]]
    : [["list"], ["list", "--json"], ["list", "--full"], ["show", "fixture.search_0"]];
  const results = [];
  for (const args of commands) {
    const child = Bun.spawn([process.execPath, "packages/ogtool/src/cli.ts", ...args], {
      cwd: new URL("..", import.meta.url).pathname,
      env: {
        ...process.env,
        OPENGENI_CODEMODE_URL: `http://127.0.0.1:${server.port}/codemode`,
        OPENGENI_CODEMODE_TOKEN: "benchmark-fixture",
        OPENGENI_CODEMODE_TOKEN_FILE: undefined,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0) throw new Error(`${args.join(" ")}: ${stderr}`);
    results.push({ command: `ogtool ${args.join(" ")}`, bytes: Buffer.byteLength(stdout) });
  }
  console.log(JSON.stringify({ fixtureTools: toolCount, results }, null, 2));
} finally {
  server.stop(true);
}

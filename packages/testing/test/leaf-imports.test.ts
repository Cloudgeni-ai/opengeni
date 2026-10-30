import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));

test.each(["settings", "fakes", "shared-pg", "compose", "process", "sse"])(
  "%s can load without unrelated schema or infrastructure initialization",
  async (leaf) => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "-e",
        `await import(${JSON.stringify(`@opengeni/testing/${leaf}`)}); console.log(JSON.stringify(Object.keys(require.cache)));`,
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    const modules = (JSON.parse(stdout) as string[]).map((path) => path.replaceAll("\\", "/"));
    for (const suffix of [
      "/packages/contracts/src/index.ts",
      "/packages/config/src/index.ts",
      "/packages/events/src/index.ts",
      "/packages/db/src/index.ts",
      "/packages/db/src/migrate.ts",
      "/packages/db/src/provision-roles.ts",
    ]) {
      expect(modules.filter((path) => path.endsWith(suffix))).toEqual([]);
    }
  },
);

test("root and leaf exports retain the same values and function identities", async () => {
  const config = await import("@opengeni/config");
  const defaults = await import("@opengeni/config/defaults");
  for (const name of Object.keys(defaults) as (keyof typeof defaults)[]) {
    expect(config[name]).toBe(defaults[name]);
  }
  const contracts = await import("@opengeni/contracts");
  const boundary = await import("@opengeni/contracts/workspace-control-event");
  for (const name of Object.keys(boundary) as (keyof typeof boundary)[]) {
    expect(contracts[name]).toBe(boundary[name]);
  }
  const events = await import("@opengeni/events");
  const durable = await import("@opengeni/events/durable-fanout");
  expect(events.SESSION_EVENT_DURABLE_FANOUT_CAPABILITY_VERSION).toBe(
    durable.SESSION_EVENT_DURABLE_FANOUT_CAPABILITY_VERSION,
  );
  expect(events.requireSessionEventDurableFanoutCapability).toBe(
    durable.requireSessionEventDurableFanoutCapability,
  );
  const apiContract = await import("@opengeni/contracts/api-contract");
  const firstPartyTools = await import("@opengeni/contracts/first-party-mcp-tools");
  const sessionSkills = await import("@opengeni/contracts/session-skills");
  const connectionResponse = await import("@opengeni/contracts/connection-response");
  expect(contracts.OPENGENI_API_CONTRACT_HEADER).toBe(apiContract.OPENGENI_API_CONTRACT_HEADER);
  expect(contracts.OPENGENI_API_CONTRACT_REVISION).toBe(apiContract.OPENGENI_API_CONTRACT_REVISION);
  expect(contracts.DEFAULT_FIRST_PARTY_MCP_TOOLS).toEqual(
    firstPartyTools.DEFAULT_FIRST_PARTY_MCP_TOOLS,
  );
  expect(contracts.SessionSkills).toBe(sessionSkills.SessionSkills);
  expect(contracts.ConnectionResponse).toBe(connectionResponse.ConnectionResponse);
});

test("lightweight contract subpaths do not load the root barrel", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "-e",
      `await import("@opengeni/contracts/api-contract"); await import("@opengeni/contracts/first-party-mcp-tools"); await import("@opengeni/contracts/session-skills"); await import("@opengeni/contracts/connection-response"); console.log(JSON.stringify(Object.keys(require.cache)));`,
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  const modules = (JSON.parse(stdout) as string[]).map((path) => path.replaceAll("\\", "/"));
  expect(modules.some((path) => path.endsWith("/packages/contracts/src/index.ts"))).toBe(false);
});

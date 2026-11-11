import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ThisComputer, type ThisComputerDeps } from "../src/this-computer";

const SERVER = "https://agents.example.test";
const MACHINE = "11111111-1111-4111-8111-111111111111";
const FIRST = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECOND = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type Call = [kind: string, workspaceId: string, enrollmentId: string];

/**
 * A stand-in agent already connected from the first workspace. It lists its
 * connections from a file and removes one when told to disconnect it.
 */
async function connectedComputer(
  options: { allowFails?: string[]; screenControlRequests?: boolean } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "og-this-computer-ws-"));
  const list = join(dir, "connections.txt");
  const log = join(dir, "calls.log");
  await writeFile(list, `  c1  ${SERVER}  workspace=${FIRST}  agent=${MACHINE}\n`);
  const agentPath = join(dir, "agent");
  await writeFile(
    agentPath,
    [
      "#!/bin/sh",
      `echo "$*" >> "${log}"`,
      'case "$1" in',
      '  --version) echo "opengeni-agent 1.0.0" ;;',
      `  connections) cat "${list}" ;;`,
      `  disconnect) grep -v "^  $2 " "${list}" > "${list}.next"; mv "${list}.next" "${list}" ;;`,
      "  run) sleep 30 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  await chmod(agentPath, 0o755);
  const calls: Call[] = [];
  const deps = {
    platform: "linux",
    arch: "x64",
    home: dir,
    env: {},
    agentSigningKey: "",
    fetch: () => Promise.reject(new Error("offline")),
    dataDir: dir,
    logDir: dir,
    agentPath,
    mintEnrollToken: (_account: string, workspaceId: string) => {
      calls.push(["mint", workspaceId, ""]);
      return Promise.reject(new Error("no new enrollment in this test"));
    },
    allowAgents: (_account: string, workspaceId: string, enrollmentId: string) => {
      calls.push(["allow", workspaceId, enrollmentId]);
      return options.allowFails?.includes(workspaceId)
        ? Promise.reject(new Error("not allowed here"))
        : Promise.resolve();
    },
    disallowAgents: (_account: string, workspaceId: string, enrollmentId: string) => {
      calls.push(["disallow", workspaceId, enrollmentId]);
      return Promise.resolve();
    },
    ...(options.screenControlRequests
      ? {
          enableScreenControl: (_account: string, workspaceId: string, enrollmentId: string) => {
            calls.push(["screen", workspaceId, enrollmentId]);
            return Promise.resolve();
          },
        }
      : {}),
    openSystemSettings: () => undefined,
    trash: () => Promise.resolve(),
    onChange: () => undefined,
  } as unknown as ThisComputerDeps;
  const computer = new ThisComputer(deps);
  const disconnects = async () =>
    (await readFile(log, "utf8").catch(() => ""))
      .split("\n")
      .filter((line) => line.startsWith("disconnect"));
  const connectedIn = async (workspaceId: string) =>
    (await computer.status(SERVER, workspaceId)).state !== "not_connected";
  cleanup = async () => {
    await computer.shutdown();
    await rm(dir, { recursive: true, force: true });
  };
  return { computer, calls, disconnects, connectedIn };
}

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

describe("one computer in several workspaces", () => {
  test("connecting in another workspace reuses the connection and only allows agents there", async () => {
    const { computer, calls, connectedIn } = await connectedComputer();
    expect(await connectedIn(SECOND)).toBe(false);

    await computer.connect("account", SERVER, SECOND, { screenControl: false });

    expect(calls).toEqual([["allow", SECOND, MACHINE]]);
    expect(await connectedIn(SECOND)).toBe(true);
    expect(await connectedIn(FIRST)).toBe(true);
  });

  test("turning it off in one workspace leaves it on in the other", async () => {
    const { computer, calls, disconnects, connectedIn } = await connectedComputer();
    await computer.connect("account", SERVER, SECOND, { screenControl: false });

    await computer.disconnect("account", SERVER, SECOND);
    expect(calls.at(-1)).toEqual(["disallow", SECOND, MACHINE]);
    expect(await disconnects()).toEqual([]);
    expect(await connectedIn(SECOND)).toBe(false);
    expect(await connectedIn(FIRST)).toBe(true);
  });

  test("turning it off where it was connected first keeps it for the other workspace", async () => {
    const { computer, calls, disconnects, connectedIn } = await connectedComputer();
    await computer.connect("account", SERVER, SECOND, { screenControl: false });

    await computer.disconnect("account", SERVER, FIRST);
    expect(calls.at(-1)).toEqual(["disallow", FIRST, MACHINE]);
    expect(await disconnects()).toEqual([]);
    expect(await connectedIn(FIRST)).toBe(false);
    expect(await connectedIn(SECOND)).toBe(true);

    // Turning it on again there reuses the same connection.
    await computer.connect("account", SERVER, FIRST, { screenControl: false });
    expect(calls.at(-1)).toEqual(["allow", FIRST, MACHINE]);
    expect(await connectedIn(FIRST)).toBe(true);
  });

  test("turning it off in the last workspace that uses it disconnects it", async () => {
    const { computer, disconnects, connectedIn } = await connectedComputer();
    await computer.connect("account", SERVER, SECOND, { screenControl: false });
    await computer.disconnect("account", SERVER, SECOND);

    await computer.disconnect("account", SERVER, FIRST);
    expect(await disconnects()).toEqual(["disconnect c1"]);
    expect(await connectedIn(FIRST)).toBe(false);
    expect(await connectedIn(SECOND)).toBe(false);
  });

  test("a workspace the server doesn't let use the connection sets the computer up as new", async () => {
    const { computer, calls } = await connectedComputer({ allowFails: [SECOND] });

    await expect(
      computer.connect("account", SERVER, SECOND, { screenControl: false }),
    ).rejects.toThrow();
    expect(calls).toEqual([
      ["allow", SECOND, MACHINE],
      ["mint", SECOND, ""],
    ]);
  });

  test("asking for screen control in another workspace gives it to the existing connection", async () => {
    const { computer, calls, connectedIn } = await connectedComputer({
      screenControlRequests: true,
    });

    await computer.connect("account", SERVER, SECOND, { screenControl: true });

    // Turned on where the connection was made, then allowed here: never set up
    // anew, which the server refuses for a person's own computer.
    expect(calls).toEqual([
      ["screen", FIRST, MACHINE],
      ["allow", SECOND, MACHINE],
    ]);
    expect(computer.screenControlConnected).toBe(true);
    expect(await connectedIn(SECOND)).toBe(true);
  });

  test("without a way to ask the server for screen control, the computer is set up as new", async () => {
    const { computer, calls } = await connectedComputer();

    await expect(
      computer.connect("account", SERVER, SECOND, { screenControl: true }),
    ).rejects.toThrow();
    expect(calls).toEqual([["mint", SECOND, ""]]);
  });
});

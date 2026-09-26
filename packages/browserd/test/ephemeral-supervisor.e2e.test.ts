import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { BrowserSupervisor, CdpConnection } from "../src";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;
e2e(
  "ephemeral supervisor partitions actors and never restores a lost shared generation",
  async () => {
    const root = await mkdtemp("/tmp/oge-");
    const sockets = await mkdtemp("/tmp/oge-s-");
    let supervisor = await BrowserSupervisor.open({
      rootDirectory: root,
      socketRootDirectory: sockets,
      ephemeralContextPoolEnabled: true,
    });
    const make = (partition: string) => ({
      browserSessionId: randomUUID(),
      controllerGeneration: randomUUID(),
      headed: false,
      transport: {
        kind: "managed" as const,
        engine: "chromium" as const,
        ephemeralPartition: partition.repeat(64),
      },
      ...(process.env.OPENGENI_TEST_CHROME_PATH
        ? { browserExecutablePath: process.env.OPENGENI_TEST_CHROME_PATH }
        : {}),
      initialUrl: "data:text/html,<h1>Fixture</h1>",
    });
    const a = make("a"),
      b = make("a"),
      c = make("b");
    try {
      const [one, two, three] = await Promise.all([
        supervisor.createSession(a),
        supervisor.createSession(b),
        supervisor.createSession(c),
      ]);
      expect(supervisor.listSessions()).toHaveLength(3);
      await expect(supervisor.screenshot(a, two.observation.target.id)).rejects.toThrow(
        "browser target does not exist",
      );
      expect(
        (await supervisor.screenshot(a, one.observation.target.id)).data.byteLength,
      ).toBeGreaterThan(1000);
      const endpoints: string[] = [];
      for (const id of await readdir(join(root, "sessions"))) {
        try {
          const [port, path] = (
            await readFile(join(root, "sessions", id, "profile", "DevToolsActivePort"), "utf8")
          )
            .trim()
            .split("\n");
          endpoints.push(`ws://127.0.0.1:${port}${path}`);
        } catch {
          /* actor journals have no process profile */
        }
      }
      expect(endpoints).toHaveLength(2);
      let killed = false;
      for (const endpoint of endpoints) {
        const connection = await CdpConnection.connect(endpoint);
        const targets = await connection.send<{ targetInfos: Array<{ targetId: string }> }>(
          "Target.getTargets",
        );
        if (targets.targetInfos.some((target) => target.targetId === one.observation.target.id)) {
          await connection.send("Browser.close").catch(() => undefined);
          killed = true;
        }
        connection.close();
      }
      expect(killed).toBe(true);
      for (let attempt = 0; attempt < 100 && supervisor.listSessions().length !== 1; attempt++)
        await Bun.sleep(25);
      await expect(supervisor.observe(a, one.observation.target.id)).rejects.toThrow();
      await expect(supervisor.observe(b, two.observation.target.id)).rejects.toThrow(
        "generation ended",
      );
      expect(supervisor.listSessions().map((session) => session.browserSessionId)).toEqual([
        c.browserSessionId,
      ]);
      expect(
        (await supervisor.screenshot(c, three.observation.target.id)).data.byteLength,
      ).toBeGreaterThan(1000);
      await supervisor.close();
      supervisor = await BrowserSupervisor.open({
        rootDirectory: root,
        socketRootDirectory: sockets,
        ephemeralContextPoolEnabled: true,
      });
      await expect(supervisor.createSession(a)).rejects.toThrow("generation already issued");
      expect(supervisor.listSessions()).toHaveLength(0);
    } finally {
      await supervisor.close();
      await rm(root, { recursive: true, force: true });
      await rm(sockets, { recursive: true, force: true });
    }
  },
  90_000,
);

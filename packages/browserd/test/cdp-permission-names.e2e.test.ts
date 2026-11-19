import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserActionCommand, BrowserObservation } from "@opengeni/contracts";
import { BrowserInteractionController } from "@opengeni/interaction";
import { AgentBrowserDriver, ManagedBrowserRunner } from "../src";
import { CdpConnection } from "../src/cdp";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

type Permission = Extract<BrowserActionCommand["action"], { type: "permission" }>["permission"];

// Every permission the action offers, with the descriptor the page itself
// queries to read it back. The motion sensors share one Chrome permission, so
// setting them shows on the gyroscope as well as the accelerometer.
const PERMISSIONS: ReadonlyArray<[Permission, ReadonlyArray<Record<string, unknown>>]> = [
  ["geolocation", [{ name: "geolocation" }]],
  ["notifications", [{ name: "notifications" }]],
  ["camera", [{ name: "camera" }]],
  ["microphone", [{ name: "microphone" }]],
  ["midi", [{ name: "midi" }]],
  ["midi_sysex", [{ name: "midi", sysex: true }]],
  ["sensors", [{ name: "accelerometer" }, { name: "gyroscope" }]],
  ["idle_detection", [{ name: "idle-detection" }]],
  ["local_fonts", [{ name: "local-fonts" }]],
  ["window_management", [{ name: "window-management" }]],
];

e2e(
  "every permission the action offers is set in Chromium and reads back on the page",
  async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response("<!doctype html><title>Permissions</title><p>Ready</p>", {
          headers: { "content-type": "text/html" },
        }),
    });
    const directory = await mkdtemp("/tmp/ogb-permission-names-");
    const browserSessionId = randomUUID();
    const controllerGeneration = `controller-${randomUUID()}`;
    const runner = await ManagedBrowserRunner.create({
      profileDirectory: join(directory, "profile"),
      headed: false,
      ...(process.env.OPENGENI_BROWSER_EXECUTABLE
        ? { browserExecutablePath: process.env.OPENGENI_BROWSER_EXECUTABLE }
        : {}),
    });
    const driver = new AgentBrowserDriver({ browserSessionId, controllerGeneration, runner });
    const controller = new BrowserInteractionController({
      browserSessionId,
      controllerGeneration,
      driver,
    });
    let cdp: CdpConnection | null = null;
    const command = (
      observation: BrowserObservation,
      action: BrowserActionCommand["action"],
    ): BrowserActionCommand => ({
      protocolVersion: 1,
      operationId: randomUUID(),
      browserSessionId,
      controllerGeneration,
      targetId: observation.target.id,
      expectedTargetGeneration: observation.target.targetGeneration,
      expectedDocumentGeneration: observation.target.documentGeneration!,
      expectedFrameId: observation.frameId!,
      actor: { kind: "agent", subjectId: "agent:permission-names" },
      observationMode: "none",
      action,
    });
    try {
      const initial = await driver.start(`${server.url}`);
      const endpoint = await runner.run<{ cdpUrl: string }>(["get", "cdp-url"]);
      cdp = await CdpConnection.connect(endpoint.cdpUrl);
      const attached = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: initial.target.id,
        flatten: true,
      });
      const query = async (descriptor: Record<string, unknown>) =>
        (
          await cdp!.send<{ result: { value: unknown } }>(
            "Runtime.evaluate",
            {
              expression: `navigator.permissions.query(${JSON.stringify(descriptor)}).then((status) => status.state)`,
              returnByValue: true,
              awaitPromise: true,
            },
            { sessionId: attached.sessionId },
          )
        ).result.value;

      for (const [permission, descriptors] of PERMISSIONS) {
        for (const setting of ["granted", "denied", "prompt"] as const) {
          const result = await controller.run(
            command(await driver.observe(initial.target.id), {
              type: "permission",
              permission,
              setting,
            }),
          );
          expect({ permission, setting, error: result.error ?? null }).toEqual({
            permission,
            setting,
            error: null,
          });
          expect(result.state).toBe("completed");
          for (const descriptor of descriptors) {
            expect({ permission, descriptor, state: await query(descriptor) }).toEqual({
              permission,
              descriptor,
              state: setting,
            });
          }
        }
      }
    } finally {
      await cdp?.close();
      await driver.close();
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);

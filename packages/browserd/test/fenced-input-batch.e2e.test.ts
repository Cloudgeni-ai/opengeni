import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserActionCommand, BrowserObservation } from "@opengeni/contracts";
import { BrowserInteractionController } from "@opengeni/interaction";
import {
  AgentBrowserDriver,
  AgentBrowserJsonRunner,
  resolvePinnedAgentBrowserBinary,
} from "../src";
import { CdpConnection } from "../src/cdp";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

e2e(
  "fenced input batches preserve event boundaries and stop after document navigation",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-input-batch-");
    const browserSessionId = randomUUID();
    const controllerGeneration = `controller-${randomUUID()}`;
    const runner = await AgentBrowserJsonRunner.create({
      namespace: `input_${randomUUID().slice(0, 8)}`,
      sessionName: "s",
      socketDirectory: join(directory, "s"),
      profileDirectory: join(directory, "profile"),
      downloadDirectory: join(directory, "downloads"),
      screenshotDirectory: join(directory, "screenshots"),
      headed: false,
      binary: await resolvePinnedAgentBrowserBinary(
        process.env.OPENGENI_BROWSERD_AGENT_BROWSER_BINARY
          ? { binaryPath: process.env.OPENGENI_BROWSERD_AGENT_BROWSER_BINARY }
          : {},
      ),
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
    const fixture = () =>
      `data:text/html,${encodeURIComponent('<!doctype html><title>Typing proof</title><input autofocus aria-label="Text"><script>globalThis.events=[]; for(const type of ["beforeinput","input"])document.querySelector("input").addEventListener(type,e=>events.push([e.type,e.data]));</script>')}`;
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
      actor: { kind: "human", subjectId: "input-batch-fixture" },
      observationMode: "none",
      action,
    });
    try {
      const initial = await driver.start(fixture());
      const endpoint = await runner.run<{ cdpUrl: string }>(["get", "cdp-url"]);
      cdp = await CdpConnection.connect(endpoint.cdpUrl);
      const attached = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: initial.target.id,
        flatten: true,
      });
      const evaluate = async (expression: string) =>
        (
          await cdp!.send<{ result: { value: unknown } }>(
            "Runtime.evaluate",
            { expression, returnByValue: true },
            { sessionId: attached.sessionId },
          )
        ).result.value;
      const input = command(initial, {
        type: "batch",
        fenceEachAction: true,
        actions: [
          { type: "type", text: "a" },
          { type: "type", text: "日" },
          { type: "type", text: "b" },
        ],
      });
      expect((await controller.run(input)).state).toBe("completed");
      expect(await evaluate('({value:document.querySelector("input").value,events})')).toEqual({
        value: "a日b",
        events: [
          ["beforeinput", "a"],
          ["input", "a"],
          ["beforeinput", "日"],
          ["input", "日"],
          ["beforeinput", "b"],
          ["input", "b"],
        ],
      });
      const characters = Array.from("abcdefghijklmnopqrstuvwx");
      const durations: { requests: number; elapsedMs: number; events: number }[] = [];
      for (const batchSize of [1, 16]) {
        await evaluate(
          'document.querySelector("input").value=""; globalThis.events=[]; document.querySelector("input").focus()',
        );
        const started = performance.now();
        let requests = 0;
        for (let offset = 0; offset < characters.length; offset += batchSize) {
          const actions = characters
            .slice(offset, offset + batchSize)
            .map((text) => ({ type: "type" as const, text }));
          // Controlled transport latency, identical for each simulated HTTP request.
          // This isolates batching benefit; it is not a production latency claim.
          await Bun.sleep(150);
          const action =
            actions.length === 1
              ? actions[0]!
              : { type: "batch" as const, fenceEachAction: true as const, actions };
          expect((await controller.run(command(initial, action))).state).toBe("completed");
          requests++;
        }
        const state = (await evaluate(
          '({value:document.querySelector("input").value,events})',
        )) as { value: string; events: unknown[] };
        expect(state.value).toBe(characters.join(""));
        expect(state.events).toEqual(
          characters.flatMap((text) => [
            ["beforeinput", text],
            ["input", text],
          ]),
        );
        durations.push({
          requests,
          elapsedMs: Math.round(performance.now() - started),
          events: state.events.length,
        });
      }
      console.log(
        JSON.stringify({
          fixture: "24 native text actions, injected 150 ms/request",
          sequential: durations[0],
          fencedBatch: durations[1],
        }),
      );
      const navigation = command(initial, {
        type: "batch",
        fenceEachAction: true,
        actions: [
          { type: "navigate", url: fixture() },
          { type: "type", text: "must not arrive" },
        ],
      });
      const stopped = await controller.run(navigation);
      expect(stopped.state).toBe("outcome_unknown");
      expect(stopped.error?.message).toContain("document_stale");
      expect(await evaluate('document.querySelector("input").value')).toBe("");
      expect(await controller.run(navigation)).toEqual(stopped);
      expect(await evaluate('document.querySelector("input").value')).toBe("");
      const fresh = await driver.observe(initial.target.id);
      const legacy = command(fresh, {
        type: "batch",
        actions: [
          { type: "navigate", url: fixture() },
          { type: "type", text: "legacy navigation batch" },
        ],
      });
      expect((await controller.run(legacy)).state).toBe("completed");
      expect(await evaluate('document.querySelector("input").value')).toBe(
        "legacy navigation batch",
      );
    } finally {
      await cdp?.close();
      await driver.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);

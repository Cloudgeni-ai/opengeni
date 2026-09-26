import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserActionCommand, BrowserObservation } from "@opengeni/contracts";
import { BrowserSupervisor, resolvePinnedLightpandaBinary } from "../src";

const binaryPath = process.env.OPENGENI_BROWSERD_LIGHTPANDA_BINARY;
const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" && binaryPath ? test : test.skip;

e2e("Lightpanda fill replaces existing values and emits native input events", async () => {
  const directory = await mkdtemp("/tmp/ogb-lp-fill-");
  const socketDirectory = `/tmp/lpf-${randomUUID().slice(0, 8)}`;
  const binary = await resolvePinnedLightpandaBinary({
    binaryPath: binaryPath!,
  });
  let submittedBody = "";
  const page = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/auth") {
        return new Response(
          `<!doctype html><form method="post" action="/done">
          <input id="username" name="username" value="old-user" autocomplete="username">
          <input id="password" name="password" type="password" value="old-password" autocomplete="current-password">
          <button id="login" type="submit">Log in</button></form>`,
          { headers: { "content-type": "text/html" } },
        );
      }
      if (new URL(request.url).pathname === "/done") {
        submittedBody = await request.text();
        return new Response("<!doctype html><h1>Submitted</h1>", {
          headers: { "content-type": "text/html" },
        });
      }
      return new Response(
        `<!doctype html><title>Fill fixture</title>
      <input id="name" value="original"><input id="email" type="email" value="old@example.test">
      <input id="number" type="number" value="12"><textarea id="note">old note</textarea>
      <input id="readonly" readonly value="unchanged"><input id="disabled" disabled value="unchanged">
      <input id="reject" value="old" oninput="this.value='rejected'">
      <button id="button">Button</button><div id="editable" contenteditable>unchanged</div>
      <output id="events">0</output><output id="last"></output>
      <script>let count=0; document.addEventListener('input', event => {
        document.querySelector('#events').textContent=String(++count);
        document.querySelector('#last').textContent=JSON.stringify({value:event.target.value,trusted:event.isTrusted});
      });</script>`,
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  const supervisor = await BrowserSupervisor.open({
    rootDirectory: join(directory, "state"),
    socketRootDirectory: socketDirectory,
    lightpandaBinary: binary,
  });
  const reference = {
    browserSessionId: randomUUID(),
    controllerGeneration: "fill-controller",
  };
  try {
    let observation = (
      await supervisor.createSession({
        ...reference,
        headed: false,
        initialUrl: `http://127.0.0.1:${page.port}`,
        transport: { kind: "managed", engine: "lightpanda" },
      })
    ).observation;
    let expectedEvents = 0;
    for (const [selector, value] of [
      ["#name", "replacement"],
      ["#name", "replacement"],
      ["#name", "different"],
      ["#name", ""],
      ["#email", "new@example.test"],
      ["#number", "34"],
      ["#note", "line one\nline two"],
    ] as const) {
      const receipt = await supervisor.action(fillCommand(observation, selector, value));
      expect(receipt.state).toBe("completed");
      observation = receipt.observation!;
      const fence = {
        expectedTargetGeneration: observation.target.targetGeneration,
        expectedDocumentGeneration: observation.target.documentGeneration!,
        expectedFrameId: observation.frameId!,
      };
      expect(
        await supervisor.readDom(reference, observation.target.id, {
          kind: "element",
          locator: { kind: "css", selector },
          ...fence,
        }),
      ).toMatchObject({ value });
      expect(
        await supervisor.readDom(reference, observation.target.id, {
          kind: "element",
          locator: { kind: "css", selector: "#events" },
          ...fence,
        }),
      ).toMatchObject({ text: String(++expectedEvents) });
      expect(
        await supervisor.readDom(reference, observation.target.id, {
          kind: "element",
          locator: { kind: "css", selector: "#last" },
          ...fence,
        }),
      ).toMatchObject({ text: JSON.stringify({ value, trusted: true }) });
    }
    for (const selector of ["#readonly", "#disabled", "#button", "#editable"]) {
      const receipt = await supervisor.action(
        fillCommand(observation, selector, "must not be inserted"),
      );
      expect(receipt.state).toBe("failed");
      expect(receipt.error?.code).toBe("invalid_action");
      observation = await supervisor.observe(reference, observation.target.id);
      const fence = {
        expectedTargetGeneration: observation.target.targetGeneration,
        expectedDocumentGeneration: observation.target.documentGeneration!,
        expectedFrameId: observation.frameId!,
      };
      expect(
        await supervisor.readDom(reference, observation.target.id, {
          kind: "element",
          locator: { kind: "css", selector: "#events" },
          ...fence,
        }),
      ).toMatchObject({ text: String(expectedEvents) });
      expect(
        await supervisor.readDom(reference, observation.target.id, {
          kind: "element",
          locator: { kind: "css", selector },
          ...fence,
        }),
      ).toMatchObject(
        selector === "#button"
          ? { text: "Button" }
          : selector === "#editable"
            ? { text: "unchanged" }
            : { value: "unchanged" },
      );
    }
    const rejectedCommand = fillCommand(observation, "#reject", "requested");
    expect((await supervisor.action(rejectedCommand)).state).toBe("outcome_unknown");
    expect((await supervisor.action(rejectedCommand)).state).toBe("outcome_unknown");
    observation = await supervisor.observe(reference, observation.target.id);
    expect(
      await supervisor.readDom(reference, observation.target.id, {
        kind: "element",
        locator: { kind: "css", selector: "#events" },
        expectedTargetGeneration: observation.target.targetGeneration,
        expectedDocumentGeneration: observation.target.documentGeneration!,
        expectedFrameId: observation.frameId!,
      }),
    ).toMatchObject({ text: String(expectedEvents + 1) });
    const origin = `http://127.0.0.1:${page.port}`;
    const navigation = await supervisor.action({
      ...fillCommand(observation, "#name", ""),
      action: { type: "navigate", url: `${origin}/auth` },
    });
    expect(navigation.state).toBe("completed");
    observation = navigation.observation!;
    const { action: _action, ...fence } = fillCommand(observation, "#username", "");
    const protectedReceipt = await supervisor.protectedAuthFill({
      ...fence,
      expectedDocumentGeneration: observation.target.documentGeneration!,
      expectedFrameId: observation.frameId!,
      actor: { kind: "system", subjectId: "protected-fill-conformance" },
      authorityId: "fixture-authority",
      credentialVersion: 1,
      allowedOrigins: [origin],
      fields: [
        {
          fieldId: "username",
          locator: { kind: "css", selector: "#username" },
          purpose: "identifier",
          value: "new-user",
        },
        {
          fieldId: "password",
          locator: { kind: "css", selector: "#password" },
          purpose: "password",
          value: "new-password",
        },
      ],
      submit: { type: "click", locator: { kind: "css", selector: "#login" } },
    });
    expect(protectedReceipt.state).toBe("completed");
    expect(new URLSearchParams(submittedBody).get("username")).toBe("new-user");
    expect(new URLSearchParams(submittedBody).get("password")).toBe("new-password");
  } finally {
    page.stop(true);
    await supervisor.close();
    await rm(directory, { recursive: true, force: true });
    await rm(socketDirectory, { recursive: true, force: true });
  }
});

function fillCommand(
  observation: BrowserObservation,
  selector: string,
  value: string,
): BrowserActionCommand {
  return {
    protocolVersion: 1,
    operationId: randomUUID(),
    browserSessionId: observation.browserSessionId,
    controllerGeneration: observation.target.controllerGeneration,
    targetId: observation.target.id,
    expectedTargetGeneration: observation.target.targetGeneration,
    expectedDocumentGeneration: observation.target.documentGeneration!,
    expectedFrameId: observation.frameId!,
    actor: { kind: "agent", subjectId: "fill-conformance" },
    action: { type: "fill", locator: { kind: "css", selector }, value },
  };
}

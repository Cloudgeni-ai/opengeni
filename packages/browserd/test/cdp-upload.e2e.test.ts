import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserActionCommand, BrowserLocator } from "@opengeni/contracts";
import { BrowserInteractionController } from "@opengeni/interaction";
import {
  AgentBrowserDriver,
  AgentBrowserJsonRunner,
  resolvePinnedAgentBrowserBinary,
} from "../src";
import { CdpConnection, CdpProtocolError } from "../src/cdp";

const e2e =
  process.env.OPENGENI_BROWSERD_E2E === "1" || process.env.OPENGENI_BROWSERD_HEADED_E2E === "1"
    ? test
    : test.skip;

for (const mode of [
  "direct",
  "button",
  "multiple",
  "label",
  "dynamic",
  "iframe",
  "no chooser",
  "dialog",
  "navigated",
  "single input rejects multiple",
] as const) {
  e2e(
    `uploads through native file selection: ${mode}`,
    async () => {
      const directory = await mkdtemp("/tmp/ogb-upload-");
      const paths = [join(directory, "one.txt"), join(directory, "two.txt")];
      await Promise.all(paths.map((path, index) => Bun.write(path, `synthetic ${index}`)));
      const ids: string[] = paths.map(() => randomUUID());
      const browserSessionId = randomUUID(),
        controllerGeneration = randomUUID();
      const runner = await AgentBrowserJsonRunner.create({
        namespace: `upload_${randomUUID().slice(0, 8)}`,
        sessionName: "s",
        socketDirectory: join(directory, "s"),
        profileDirectory: join(directory, "profile"),
        downloadDirectory: join(directory, "downloads"),
        screenshotDirectory: join(directory, "screenshots"),
        headed: process.env.OPENGENI_BROWSERD_HEADED_E2E === "1",
        binary: await resolvePinnedAgentBrowserBinary(
          process.env.OPENGENI_BROWSERD_AGENT_BROWSER_BINARY
            ? { binaryPath: process.env.OPENGENI_BROWSERD_AGENT_BROWSER_BINARY }
            : {},
        ),
        ...(process.env.OPENGENI_BROWSER_EXECUTABLE
          ? { browserExecutablePath: process.env.OPENGENI_BROWSER_EXECUTABLE }
          : {}),
      });
      const interceptions: boolean[] = [];
      let fileWrites = 0;
      const driver = new AgentBrowserDriver({
        browserSessionId,
        controllerGeneration,
        runner,
        resolveWorkspaceFiles: async (_operation, selected) =>
          selected.map((id) => paths[ids.indexOf(id)]!),
        connect: async (endpoint) => {
          const connection = await CdpConnection.connect(endpoint);
          return {
            send: async <T = Record<string, unknown>>(
              method: string,
              params?: Readonly<Record<string, unknown>>,
              options?: { sessionId?: string; timeoutMs?: number; signal?: AbortSignal },
            ) => {
              if (method === "DOM.setFileInputFiles") fileWrites++;
              if (method === "Page.setInterceptFileChooserDialog")
                interceptions.push(params?.enabled === true);
              return await connection.send<T>(method, params, options);
            },
            on: connection.on.bind(connection),
            onDisconnect: connection.onDisconnect.bind(connection),
            close: connection.close.bind(connection),
            waitForEvent: async (method, options) => {
              const event = await connection.waitForEvent(method, {
                ...options,
                ...(mode === "no chooser" ? { timeoutMs: 150 } : {}),
              });
              if (mode === "navigated" && method === "Page.fileChooserOpened") {
                const navigated = connection.waitForEvent("Page.frameNavigated", {
                  ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
                });
                await connection.send("Page.navigate", { url: "about:blank" }, options);
                await navigated;
              }
              return event;
            },
          };
        },
      });
      const controller = new BrowserInteractionController({
        browserSessionId,
        controllerGeneration,
        driver,
      });
      let cdp: CdpConnection | null = null;
      try {
        const multiple = mode === "multiple";
        const handler =
          mode === "no chooser"
            ? ""
            : mode === "dialog"
              ? "alert('Upload question')"
              : mode === "dynamic"
                ? "const input=document.createElement('input');input.type='file';input.onchange=record;document.body.append(input);input.click()"
                : "document.querySelector('input').click()";
        const content = `<!doctype html><script>
        globalThis.clicks=0;globalThis.changes=0;globalThis.uploaded=[];
        function record(event){changes++; uploaded=Array.from(event.target.files,file=>file.name);document.querySelector('p').textContent='Uploaded '+uploaded.join(', ')}
      </script>
      <input id="file" type="file" aria-label="Upload input" ${multiple ? "multiple" : ""} ${mode === "direct" || mode === "single input rejects multiple" ? "" : "hidden"} onchange="record(event)">
      ${mode === "label" ? '<label for="file">Upload files</label>' : `<button onclick="clicks++;${handler}">Upload files</button>`}<p>Ready</p>`;
        const html =
          mode === "iframe"
            ? `<!doctype html><iframe title="Upload frame" srcdoc="${content.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"></iframe>`
            : content;
        let page = await driver.start("data:text/html," + encodeURIComponent(html));
        const endpoint = await runner.run<{ cdpUrl: string }>(["get", "cdp-url"]);
        cdp = await CdpConnection.connect(endpoint.cdpUrl);
        const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
          targetId: page.target.id,
          flatten: true,
        });
        await cdp.send("Page.enable", {}, { sessionId });
        // Wait for iframe parsing through ordinary observation, not a fixed delay.
        if (mode === "iframe") page = await driver.observe(page.target.id);
        const locator: BrowserLocator =
          mode === "direct" || mode === "single input rejects multiple"
            ? { kind: "css", selector: "#file" }
            : mode === "label"
              ? { kind: "text", text: "Upload files" }
              : { kind: "role", role: "button", name: "Upload files", exact: true };
        const command: BrowserActionCommand = {
          protocolVersion: 1,
          operationId: randomUUID(),
          browserSessionId,
          controllerGeneration,
          targetId: page.target.id,
          expectedTargetGeneration: page.target.targetGeneration,
          expectedDocumentGeneration: page.target.documentGeneration,
          expectedFrameId: page.frameId!,
          actor: { kind: "agent", subjectId: "upload-e2e" },
          action: {
            type: "upload",
            locator,
            workspaceFileIds:
              multiple || mode === "single input rejects multiple" ? ids : [ids[0]!],
          },
        };
        const receipt = await controller.run(command);
        const rejected = mode === "single input rejects multiple";
        const uncertain = mode === "no chooser" || mode === "dialog" || mode === "navigated";
        expect(receipt.state).toBe(
          rejected ? "failed" : uncertain ? "outcome_unknown" : "completed",
        );
        expect(receipt.error?.code ?? null).toBe(
          rejected ? "invalid_action" : uncertain ? "outcome_unknown" : null,
        );
        expect(await controller.run(command)).toEqual(receipt);
        if (mode === "dialog") {
          expect(receipt.error?.message).toContain("JavaScript dialog");
          // Some managed headless builds dismiss alerts automatically.
          await cdp
            .send("Page.handleJavaScriptDialog", { accept: false }, { sessionId })
            .catch((error) => {
              if (!(error instanceof CdpProtocolError) || error.message !== "No dialog is showing")
                throw error;
            });
        }
        if (mode === "navigated") {
          expect(receipt.error?.message).toContain("changed documents");
          expect(fileWrites).toBe(0);
          expect(interceptions).toEqual([true, false]);
          expect((await driver.observe(page.target.id)).target.documentGeneration).not.toBe(
            page.target.documentGeneration,
          );
          return;
        }
        const data = await cdp.send<{ result: { value: unknown } }>(
          "Runtime.evaluate",
          {
            expression:
              mode === "iframe"
                ? "(()=>{const w=document.querySelector('iframe').contentWindow;return {clicks:w.clicks,changes:w.changes,uploaded:w.uploaded}})()"
                : "({clicks,changes,uploaded})",
            returnByValue: true,
          },
          { sessionId },
        );
        expect(data.result.value).toEqual({
          clicks: mode === "direct" || mode === "label" || rejected ? 0 : 1,
          changes: rejected || uncertain ? 0 : 1,
          uploaded: rejected || uncertain ? [] : multiple ? ["one.txt", "two.txt"] : ["one.txt"],
        });
        expect(interceptions).toEqual(mode === "direct" || rejected ? [] : [true, false]);
        expect((await driver.observe(page.target.id)).target.targetGeneration).toBe(
          page.target.targetGeneration,
        );
      } finally {
        cdp?.close();
        await driver.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    45_000,
  );
}

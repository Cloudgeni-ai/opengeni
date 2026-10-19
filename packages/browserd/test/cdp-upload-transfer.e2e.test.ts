import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, truncate } from "node:fs/promises";
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

// Chrome refuses DOM.setFileInputFiles from an extension debugger that has no
// file URL access. The driver must then put the files on the input itself.
for (const mode of ["direct", "button", "multiple", "large", "too large"] as const) {
  e2e(
    `uploads without Chrome file access: ${mode}`,
    async () => {
      const directory = await mkdtemp("/tmp/ogb-upload-transfer-");
      const paths = [join(directory, "contacts.csv"), join(directory, "photo.png")];
      const large = Buffer.alloc(1_500_000);
      for (let index = 0; index < large.length; index += 1) large[index] = (index * 31) % 251;
      await Bun.write(paths[0]!, mode === "large" ? large : "name,email\nAda,ada@example.com\n");
      await Bun.write(paths[1]!, "not really a png");
      if (mode === "too large") await truncate(paths[0]!, 33 * 1024 * 1024);
      const ids: string[] = paths.map(() => randomUUID());
      const browserSessionId = randomUUID(),
        controllerGeneration = randomUUID();
      const runner = await AgentBrowserJsonRunner.create({
        namespace: `upload_transfer_${randomUUID().slice(0, 8)}`,
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
      let refusals = 0;
      let largestCommand = 0;
      const driver = new AgentBrowserDriver({
        browserSessionId,
        controllerGeneration,
        runner,
        engine: "chrome",
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
              largestCommand = Math.max(
                largestCommand,
                JSON.stringify({ method, params: params ?? {} }).length,
              );
              if (method === "DOM.setFileInputFiles") {
                refusals++;
                throw new CdpProtocolError(method, -32_000, "Not allowed");
              }
              return await connection.send<T>(method, params, options);
            },
            on: connection.on.bind(connection),
            onDisconnect: connection.onDisconnect.bind(connection),
            close: connection.close.bind(connection),
            waitForEvent: connection.waitForEvent.bind(connection),
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
        const html = `<!doctype html><script>
          globalThis.inputs=0;globalThis.changes=0;globalThis.uploaded=[];
          async function record(event){
            changes++;
            uploaded=await Promise.all(Array.from(event.target.files,async file=>{
              let checksum=0;
              for(const byte of new Uint8Array(await file.arrayBuffer())) checksum=(checksum*31+byte)>>>0;
              return {name:file.name,type:file.type,size:file.size,checksum};
            }));
          }
        </script>
        <input id="file" type="file" aria-label="Upload input" ${multiple ? "multiple" : ""}
          ${mode === "button" ? "hidden" : ""} oninput="inputs++" onchange="record(event)">
        <button onclick="document.querySelector('input').click()">Upload files</button>`;
        const page = await driver.start("data:text/html," + encodeURIComponent(html));
        const endpoint = await runner.run<{ cdpUrl: string }>(["get", "cdp-url"]);
        cdp = await CdpConnection.connect(endpoint.cdpUrl);
        const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
          targetId: page.target.id,
          flatten: true,
        });
        const locator: BrowserLocator =
          mode === "button"
            ? { kind: "role", role: "button", name: "Upload files", exact: true }
            : { kind: "css", selector: "#file" };
        const command: BrowserActionCommand = {
          protocolVersion: 1,
          operationId: randomUUID(),
          browserSessionId,
          controllerGeneration,
          targetId: page.target.id,
          expectedTargetGeneration: page.target.targetGeneration,
          expectedDocumentGeneration: page.target.documentGeneration,
          expectedFrameId: page.frameId!,
          actor: { kind: "agent", subjectId: "upload-transfer-e2e" },
          action: { type: "upload", locator, workspaceFileIds: multiple ? ids : [ids[0]!] },
        };
        const receipt = await controller.run(command);
        if (mode === "too large") {
          expect(receipt.state).toBe("failed");
          expect(receipt.error?.code).toBe("unsupported");
          expect(receipt.error?.message).toContain("Allow access to file URLs");
        } else {
          expect(receipt.state).toBe("completed");
          expect(receipt.error).toBeNull();
        }
        expect(refusals).toBe(1);
        // Every command fits the attached bridge's one-megabyte request limit.
        expect(largestCommand).toBeLessThan(1024 * 1024 - 4096);
        let data: { result: { value: unknown } } | null = null;
        for (let attempt = 0; attempt < 50; attempt += 1) {
          data = await cdp.send<{ result: { value: unknown } }>(
            "Runtime.evaluate",
            { expression: "({inputs,changes,uploaded})", returnByValue: true },
            { sessionId },
          );
          const value = data.result.value as { changes: number; uploaded: unknown[] };
          if (mode === "too large" || value.uploaded.length > 0) break;
          await Bun.sleep(20);
        }
        const checksum = (value: Buffer | string) => {
          let sum = 0;
          for (const byte of Buffer.from(value)) sum = (sum * 31 + byte) >>> 0;
          return sum;
        };
        const csv = {
          name: "contacts.csv",
          type: "text/csv",
          size: mode === "large" ? large.length : 31,
          checksum: checksum(mode === "large" ? large : "name,email\nAda,ada@example.com\n"),
        };
        expect(data!.result.value).toEqual(
          mode === "too large"
            ? { inputs: 0, changes: 0, uploaded: [] }
            : {
                inputs: 1,
                changes: 1,
                uploaded: multiple
                  ? [
                      csv,
                      {
                        name: "photo.png",
                        type: "image/png",
                        size: 16,
                        checksum: checksum("not really a png"),
                      },
                    ]
                  : [csv],
              },
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

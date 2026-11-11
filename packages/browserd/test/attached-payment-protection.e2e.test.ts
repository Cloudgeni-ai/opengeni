import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { BrowserInteractionController } from "@opengeni/interaction";
import type { BrowserObservation } from "@opengeni/contracts";
import { AttachedBrowserBridgeError } from "../src/attached-bridge";
import { AttachedChromeCdpConnection } from "../src/attached-cdp";
import { AgentBrowserDriver } from "../src/cdp-driver";

// The Opengeni Browser extension, built from this repository, drives a real
// Chromium tab of a synthetic checkout the way a person's own Chrome is driven.
const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

const EXTENSION_ROOT = resolve(import.meta.dir, "../../../apps/browser-extension");
// Public synthetic fixtures, never a live payment profile.
const PAN = "4000000000000002";
const GROUPED = "4000 0000 0000 0002";
const CVC = "731";

const CHECKOUT = `<!doctype html><html><head><title>Synthetic checkout</title></head>
<body><h1>Synthetic checkout</h1>
<form onsubmit="return false">
<label for="cc">Card number</label>
<input id="cc" name="cardnumber" autocomplete="cc-number" inputmode="numeric">
<label for="cvc">Security code</label>
<input id="cvc" name="cvc" autocomplete="cc-csc" value="${CVC}">
<label for="cc2">Altered card number</label>
<input id="cc2" name="cardnumber2" autocomplete="cc-number">
</form>
<script>
const cc = document.getElementById("cc");
cc.addEventListener("input", () => {
  const digits = cc.value.replace(/\\D/g, "").slice(0, 16);
  cc.value = digits.replace(/(\\d{4})(?=\\d)/g, "$1 ");
});
const cc2 = document.getElementById("cc2");
cc2.addEventListener("input", () => {
  cc2.value = cc2.value.replace(/\\D/g, "").replace(/2/g, "9");
});
</script></body></html>`;

/** Generated identifiers, timestamps, numbers and the fixture's own origin are
 * not page content; a random UUID or port may contain the code's digits.
 * Every other string stays under test. */
const GENERATED_KEY = /^(id|ref|type)$|(Id|Ids|Ref|Generation|Digest|At)$/u;
function contentJson(value: unknown, origin: string): string {
  return JSON.stringify(value, (key, item: unknown) => {
    if (GENERATED_KEY.test(key) || typeof item === "number") return "<generated>";
    return typeof item === "string" ? item.replaceAll(origin, "<fixture-origin>") : item;
  });
}

async function launch() {
  const directory = await mkdtemp("/tmp/ogb-attached-payment-e2e-");
  const extension = join(directory, "extension");
  const build = Bun.spawnSync(
    [process.execPath, join(EXTENSION_ROOT, "scripts/build.ts"), "--out", extension],
    { cwd: EXTENSION_ROOT, stdout: "ignore", stderr: "pipe" },
  );
  if (build.exitCode !== 0) throw new Error(`extension build failed: ${build.stderr.toString()}`);
  const site = serveOnPortContaining(CVC);

  const profile = join(directory, "profile");
  const socketPath = join(directory, "bridge.sock");
  const hostScript = join(directory, "host.ts");
  await writeFile(
    hostScript,
    `import { connect } from "node:net";
const socket = connect(${JSON.stringify(socketPath)});
let input = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  while (input.length >= 4) {
    const length = input.readUInt32LE(0);
    if (input.length < length + 4) return;
    socket.write(input.subarray(4, length + 4).toString("utf8") + "\\n");
    input = input.subarray(length + 4);
  }
});
let lines = "";
socket.on("data", (chunk) => {
  lines += chunk.toString("utf8");
  for (let at = lines.indexOf("\\n"); at >= 0; at = lines.indexOf("\\n")) {
    const body = Buffer.from(lines.slice(0, at));
    lines = lines.slice(at + 1);
    const length = Buffer.alloc(4);
    length.writeUInt32LE(body.length, 0);
    process.stdout.write(Buffer.concat([length, body]));
  }
});
socket.on("close", () => process.exit(0));
process.stdin.on("end", () => process.exit(0));
`,
  );
  const hostLauncher = join(directory, "host.sh");
  const environment = Object.entries(process.env)
    .filter(([name]) => name === "LD_LIBRARY_PATH")
    .map(([name, value]) => `export ${name}='${value}'\n`)
    .join("");
  await writeFile(
    hostLauncher,
    `#!/bin/sh\n${environment}exec '${process.execPath}' '${hostScript}'\n`,
  );
  await chmod(hostLauncher, 0o755);
  const manifest = JSON.parse(await readFile(join(extension, "manifest.json"), "utf8"));
  const extensionId = [
    ...createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32),
  ]
    .map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)))
    .join("");
  await mkdir(join(profile, "NativeMessagingHosts"), { recursive: true });
  await writeFile(
    join(profile, "NativeMessagingHosts", "ai.opengeni.browser.json"),
    JSON.stringify({
      name: "ai.opengeni.browser",
      description: "Test bridge",
      path: hostLauncher,
      type: "stdio",
      allowed_origins: [`chrome-extension://${extensionId}/`],
    }),
  );

  let device = { id: "", generation: "" };
  let send: ((message: unknown) => void) | null = null;
  const replies = new Map<string, (reply: any) => void>();
  let connected!: () => void;
  const ready = new Promise<void>((done) => (connected = done));
  const server: Server = createServer((socket: Socket) => {
    let lines = "";
    socket.on("data", (chunk) => {
      lines += chunk.toString("utf8");
      for (let at = lines.indexOf("\n"); at >= 0; at = lines.indexOf("\n")) {
        const message = JSON.parse(lines.slice(0, at));
        lines = lines.slice(at + 1);
        if (message.type === "hello") {
          device = { id: message.device.id, generation: message.device.connectionGeneration };
          send = (value) => socket.write(`${JSON.stringify(value)}\n`);
          send({
            type: "ready",
            protocolVersion: 1,
            deviceId: device.id,
            connectionGeneration: device.generation,
          });
          connected();
        } else if (message.type === "command_result") {
          replies.get(message.requestId)?.(message);
          replies.delete(message.requestId);
        }
      }
    });
  });
  await new Promise<void>((listening) => server.listen(socketPath, listening));
  const chrome = Bun.spawn(
    [
      process.env.OPENGENI_BROWSER_EXECUTABLE ?? "chromium",
      ...(process.env.OPENGENI_BROWSERD_HEADED === "1" ? [] : ["--headless=new"]),
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${profile}`,
      `--load-extension=${extension}`,
      `--disable-extensions-except=${extension}`,
      "about:blank",
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  const close = async () => {
    chrome.kill();
    await chrome.exited;
    server.close();
    site.stop(true);
    await rm(directory, { recursive: true, force: true });
  };
  try {
    await Promise.race([
      ready,
      Bun.sleep(30_000).then(() => {
        throw new Error("the extension did not connect to its native host");
      }),
    ]);
  } catch (error) {
    await close();
    throw error;
  }

  const request = async (payload: Record<string, unknown>): Promise<any> => {
    const requestId = randomUUID();
    const reply = await new Promise<any>((settle) => {
      replies.set(requestId, settle);
      send!({
        type: "command",
        protocolVersion: 1,
        requestId,
        deviceId: device.id,
        connectionGeneration: device.generation,
        payload,
      });
    });
    if (reply.ok) return reply.payload;
    const known = [
      "resource_unavailable",
      "fenced",
      "timeout",
      "bridge_failed",
      "debugger_unavailable",
      "invalid_request",
    ];
    const code = known.includes(reply.error.code) ? reply.error.code : "driver_rejected";
    throw new AttachedBrowserBridgeError(
      code,
      reply.error.message,
      reply.error.retryable,
      code === "driver_rejected" ? { extensionCode: reply.error.code } : undefined,
    );
  };
  const origin = `http://127.0.0.1:${site.port}`;
  await request({ type: "tabs.create", url: `${origin}/checkout` });
  const connection = new AttachedChromeCdpConnection(
    { request, close: () => undefined },
    { browserName: "Chrome", browserVersion: "155.0.0.0" },
  );
  const browserSessionId = randomUUID();
  const controllerGeneration = `attached-payment-${randomUUID()}`;
  const driver = new AgentBrowserDriver({
    browserSessionId,
    controllerGeneration,
    engine: "chrome",
    runner: {
      async run<T>() {
        return { cdpUrl: "opengeni-attached://local" } as T;
      },
    },
    connect: async () => connection,
  });
  await driver.start();
  const controller = new BrowserInteractionController({
    browserSessionId,
    controllerGeneration,
    driver,
  });
  let targetId = "";
  for (let attempt = 0; attempt < 50 && !targetId; attempt++) {
    const targets = await driver.listTargets();
    targetId = targets.find((target) => target.url.startsWith(`${origin}/checkout`))?.id ?? "";
    if (!targetId) await Bun.sleep(100);
  }
  const act = async (observation: BrowserObservation, action: Record<string, unknown>) =>
    await controller.run({
      protocolVersion: 1,
      actor: { kind: "agent", subjectId: "agent:e2e" },
      operationId: randomUUID(),
      browserSessionId,
      controllerGeneration,
      targetId,
      expectedTargetGeneration: observation.target.targetGeneration,
      expectedDocumentGeneration: observation.target.documentGeneration!,
      expectedFrameId: observation.frameId,
      action: action as never,
    });
  return {
    origin,
    driver,
    targetId: () => targetId,
    observe: async () => await controller.observe(targetId),
    act,
    close: async () => {
      await driver.close().catch(() => undefined);
      connection.close();
      await close();
    },
  };
}

/** The checkout, on a port whose digits contain the security code, as a
 * person's own local server can be: the address must stay usable. */
function serveOnPortContaining(digits: string) {
  for (let port = 40_000; port < 65_000; port++) {
    if (!String(port).includes(digits)) continue;
    try {
      return Bun.serve({
        hostname: "127.0.0.1",
        port,
        fetch: () => new Response(CHECKOUT, { headers: { "content-type": "text/html" } }),
      });
    } catch {
      // In use; try the next one.
    }
  }
  throw new Error(`no free port containing ${digits}`);
}

type Node = { role?: string; name?: string; ref?: string; children?: Node[] };
const nodes = (observation: BrowserObservation): Node[] => {
  const all = (list: Node[]): Node[] => list.flatMap((node) => [node, ...all(node.children ?? [])]);
  return all(
    (observation.semantic?.kind === "snapshot" ? observation.semantic.roots : []) as Node[],
  );
};
const ref = (observation: BrowserObservation, role: string, name: string) => {
  const found = nodes(observation).find((node) => node.role === role && node.name === name)?.ref;
  if (!found) throw new Error(`no ${role} named ${name}`);
  return { kind: "ref", ref: found };
};

e2e(
  "a connected Chrome checkout keeps payment field values out of observations and fills, and its address usable",
  async () => {
    const fixture = await launch();
    try {
      let observation = await fixture.observe();
      expect(observation.target.url).toBe(`${fixture.origin}/checkout`);
      expect(contentJson(observation, fixture.origin)).not.toContain(CVC);

      const filled = await fixture.act(observation, {
        type: "fill",
        locator: ref(observation, "textbox", "Card number"),
        value: PAN,
      });
      expect(filled.state, JSON.stringify(filled.error)).toBe("completed");
      for (const secret of [PAN, GROUPED, CVC])
        expect(contentJson(filled, fixture.origin)).not.toContain(secret);

      observation = await fixture.observe();
      expect(observation.target.url).toBe(`${fixture.origin}/checkout`);
      for (const secret of [PAN, GROUPED, CVC])
        expect(contentJson(observation, fixture.origin)).not.toContain(secret);
      const tabs = await fixture.driver.listTargets();
      expect(tabs.map((tab) => tab.url)).toContain(`${fixture.origin}/checkout`);

      const altered = await fixture.act(observation, {
        type: "fill",
        locator: ref(observation, "textbox", "Altered card number"),
        value: PAN,
      });
      expect(altered.state, JSON.stringify(altered.error)).toBe("outcome_unknown");
      for (const secret of [PAN, GROUPED, CVC, "4000000000000009"])
        expect(contentJson(altered, fixture.origin)).not.toContain(secret);

      observation = await fixture.observe();
      for (const secret of [PAN, GROUPED, CVC, "4000000000000009"])
        expect(contentJson(observation, fixture.origin)).not.toContain(secret);
    } finally {
      await fixture.close();
    }
  },
  90_000,
);

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
// Chromium tab next to a stand-in password manager: an extension that shows
// its inline menu (a frame of its own page) whenever a field gets focus.
// Chrome ends the extension's debugging of a tab when such a frame appears.
const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

const EXTENSION_ROOT = resolve(import.meta.dir, "../../../apps/browser-extension");

// "src": the menu frame's address is its page; "blank": the frame is created
// blank and then loaded with the page, so its address does not show it.
const PASSWORD_MANAGER = `
let host = null;
let frame = null;
document.addEventListener("focusin", (event) => {
  if (!(event.target instanceof HTMLInputElement)) return;
  if (host?.isConnected && frame?.isConnected) return;
  host?.remove();
  host = document.createElement("inline-menu-fixture");
  const shadow = host.attachShadow({ mode: "closed" });
  frame = document.createElement("iframe");
  const blank = document.documentElement.dataset.menu === "blank";
  if (!blank) frame.src = chrome.runtime.getURL("menu.html");
  shadow.appendChild(frame);
  document.documentElement.appendChild(host);
  if (blank) frame.contentWindow.location.href = chrome.runtime.getURL("menu.html");
}, true);
// Escape closes the menu, as in password managers.
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") host?.remove();
}, true);
`;

// Frames of the page's own that the Opengeni extension cannot script, each
// created blank and loaded by script: an error page, a page that keeps
// navigating itself, and the target of a form posted to another origin whose
// page posts itself again, as in a payment challenge.
const PAGE_FRAMES = ["error", "hopping", "posted"] as const;

function page(menu: "src" | "blank", otherOrigin: string, pageFrames: boolean): string {
  const frames = pageFrames
    ? `<iframe id="error" title="Error"></iframe><iframe id="hopping" title="Hopping"></iframe>
<iframe id="posted" name="posted" title="Posted"></iframe>
<form id="post" method="post" target="posted" action="${otherOrigin}/post"><input type="hidden" name="step" value="1"></form>
<script>
document.getElementById("error").contentWindow.location.href = "http://127.0.0.1:9/";
document.getElementById("hopping").contentWindow.location.href = ${JSON.stringify(otherOrigin)} + "/hop";
document.getElementById("post").submit();
</script>`
    : "";
  return `<!doctype html><html data-menu="${menu}"><head><title>Verify</title></head><body>
<div id="box"><input id="email" aria-label="Email" value="a@example.com">
<button type="button" id="send">Send code to email</button>
<button type="button" id="arm">Focus the email field soon</button></div>
<p id="frames"></p>
<iframe id="widget" title="Widget"></iframe>
${frames}
<script>
// The page's own frame, created blank and loaded from another origin by script.
document.getElementById("widget").contentWindow.location.href = ${JSON.stringify(otherOrigin)} + "/widget";
setInterval(() => {
  document.getElementById("frames").textContent = "widget " + (document.getElementById("widget") ? "present" : "removed");
  // Tells the test which of its frames the page still holds, also while
  // the tab cannot be debugged.
  const held = [...document.querySelectorAll("iframe")].map((frame) => frame.id).filter(Boolean);
  fetch("/frames", { method: "POST", body: held.join(",") }).catch(() => {});
}, 50);
// The person presses Escape (see /escape).
setInterval(async () => {
  const pressed = await fetch("/escape").then((response) => response.text()).catch(() => "");
  if (pressed === "yes") document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}, 100);
document.getElementById("arm").onclick = () => setTimeout(() => document.getElementById("email").focus(), 1200);
document.getElementById("send").onclick = () => {
  document.getElementById("box").innerHTML = '<input id="code" aria-label="Code"><button type="button" id="verify">Verify</button><p id="out"></p>';
  document.getElementById("code").focus();
  document.getElementById("verify").onclick = () => {
    document.getElementById("out").textContent = "verified " + document.getElementById("code").value;
  };
};
</script></body></html>`;
}

type Fixture = Awaited<ReturnType<typeof launch>>;

async function launch(menu: "src" | "blank", pageFrames: boolean) {
  const directory = await mkdtemp("/tmp/ogb-extension-frame-e2e-");
  const extension = join(directory, "extension");
  const build = Bun.spawnSync(
    [process.execPath, join(EXTENSION_ROOT, "scripts/build.ts"), "--out", extension],
    { cwd: EXTENSION_ROOT, stdout: "ignore", stderr: "pipe" },
  );
  if (build.exitCode !== 0) throw new Error(`extension build failed: ${build.stderr.toString()}`);
  const manager = join(directory, "password-manager");
  await mkdir(manager);
  await writeFile(
    join(manager, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "Inline menu fixture",
      version: "1.0",
      content_scripts: [{ matches: ["<all_urls>"], js: ["content.js"], all_frames: true }],
      web_accessible_resources: [{ resources: ["menu.html"], matches: ["<all_urls>"] }],
    }),
  );
  await writeFile(join(manager, "content.js"), PASSWORD_MANAGER);
  await writeFile(join(manager, "menu.html"), "<!doctype html><title>Menu</title><p>Fill</p>");

  const other = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const path = new URL(request.url).pathname;
      const body =
        path === "/hop"
          ? "<!doctype html><title>Hop</title><script>setTimeout(() => location.replace('/hop?' + Date.now()), 200)</script>"
          : path === "/post"
            ? `<!doctype html><title>Challenge</title><form id="again" method="post" action="/post"></form><script>setTimeout(() => document.getElementById("again").submit(), 250)</script>`
            : "<!doctype html><title>Widget</title><p>Widget</p>";
      return new Response(body, { headers: { "content-type": "text/html" } });
    },
  });
  let heldFrames: string[] = [];
  let escape = false;
  const site = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/frames") {
        heldFrames = (await request.text()).split(",").filter(Boolean);
        return new Response("");
      }
      if (path === "/escape") return new Response(escape ? "yes" : "no");
      return new Response(page(menu, `http://localhost:${other.port}`, pageFrames), {
        headers: { "content-type": "text/html" },
      });
    },
  });

  // A native messaging host that relays the extension's messages to this test.
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
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${profile}`,
      `--load-extension=${extension},${manager}`,
      `--disable-extensions-except=${extension},${manager}`,
      "about:blank",
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  const close = async () => {
    chrome.kill();
    await chrome.exited;
    server.close();
    site.stop(true);
    other.stop(true);
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
  await request({ type: "tabs.create", url: `http://127.0.0.1:${site.port}/` });
  const connection = new AttachedChromeCdpConnection(
    { request, close: () => undefined },
    { browserName: "Chrome", browserVersion: "155.0.0.0" },
  );
  const browserSessionId = randomUUID();
  const controllerGeneration = `extension-frame-${randomUUID()}`;
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
    targetId = targets.find((target) => target.url.includes(`127.0.0.1:${site.port}`))?.id ?? "";
    if (!targetId) await Bun.sleep(100);
  }
  const observe = async () => await controller.observe(targetId);
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
    observe,
    act,
    heldFrames: () => heldFrames,
    pressEscape: () => {
      escape = true;
    },
    close: async () => {
      await driver.close().catch(() => undefined);
      connection.close();
      await close();
    },
  };
}

type Node = { role?: string; name?: string; ref?: string; children?: Node[] };
const nodes = (observation: BrowserObservation): Node[] => {
  const all = (list: Node[]): Node[] => list.flatMap((node) => [node, ...all(node.children ?? [])]);
  return all(
    (observation.semantic?.kind === "snapshot" ? observation.semantic.roots : []) as Node[],
  );
};
const ref = (observation: BrowserObservation, role: string, name: string) => {
  const found = nodes(observation).find(
    (node) => node.role === role && (node.name ?? "").includes(name),
  )?.ref;
  if (!found) throw new Error(`no ${role} named ${name}`);
  return { kind: "ref", ref: found };
};
const shows = (observation: BrowserObservation, text: string) =>
  nodes(observation).some((node) => (node.name ?? "").includes(text));

async function withFixture(
  menu: "src" | "blank",
  run: (fixture: Fixture) => Promise<void>,
  pageFrames = false,
) {
  const fixture = await launch(menu, pageFrames);
  try {
    await run(fixture);
  } finally {
    await fixture.close();
  }
}

e2e(
  "a sign-in page stays controllable while a password manager loads its inline menu into a blank frame",
  async () => {
    await withFixture("blank", async ({ observe, act }) => {
      let observation = await observe();
      // The click shows the menu, and Chrome ends debugging of the tab.
      const focus = await act(observation, {
        type: "click",
        locator: ref(observation, "textbox", "Email"),
      });
      expect(["completed", "outcome_unknown"]).toContain(focus.state);
      observation = await observe();
      const send = await act(observation, {
        type: "click",
        locator: ref(observation, "button", "Send code"),
      });
      expect(["completed", "outcome_unknown"]).toContain(send.state);
      observation = await observe();
      observation = await observe();
      const fill = await act(observation, {
        type: "fill",
        locator: ref(observation, "textbox", "Code"),
        value: "123456",
      });
      expect(fill.state).toBe("completed");
      observation = await observe();
      const verify = await act(observation, {
        type: "click",
        locator: ref(observation, "button", "Verify"),
      });
      expect(verify.state).toBe("completed");
      observation = await observe();
      expect(shows(observation, "verified 123456")).toBe(true);
      // The page's own frame, also loaded by script from another origin, stays.
      expect(shows(observation, "widget present")).toBe(true);
    });
  },
  90_000,
);

e2e(
  "the page's own frames that the extension cannot script are never removed with a password manager's blank-created menu",
  async () => {
    await withFixture(
      "blank",
      async ({ observe, act, heldFrames, pressEscape }) => {
        const before = await observe();
        // The click shows the menu, and Chrome ends debugging of the tab.
        const focus = await act(before, {
          type: "click",
          locator: ref(before, "textbox", "Email"),
        });
        expect(["completed", "outcome_unknown"]).toContain(focus.state);
        // Each attempt removes other extensions' frames before attaching
        // again. The page holds frames the extension cannot see into, so it
        // cannot tell which one is the menu: it removes none and says so.
        for (let attempt = 0; attempt < 3; attempt++) {
          const error = await observe().then(
            () => null,
            (failure: Error) => failure,
          );
          if (error !== null) expect(error.message).toContain("could not be removed");
          await Bun.sleep(300);
          expect(heldFrames()).toEqual(expect.arrayContaining(["widget", ...PAGE_FRAMES]));
        }
        // Once the person closes the menu, the tab can be debugged again, and
        // the agent goes on with its earlier observation of the unchanged page.
        pressEscape();
        let debuggable = false;
        for (let attempt = 0; attempt < 20 && !debuggable; attempt++) {
          await Bun.sleep(300);
          debuggable = await observe().then(
            () => true,
            () => false,
          );
        }
        expect(debuggable).toBe(true);
        const send = await act(before, {
          type: "click",
          locator: ref(before, "button", "Send code"),
        });
        expect(send.error?.code).not.toBe("target_stale");
        // The click focuses the code field, so the menu shows (and closes) again.
        expect(["completed", "outcome_unknown"]).toContain(send.state);
        let after: BrowserObservation | null = null;
        for (let attempt = 0; attempt < 10 && after === null; attempt++) {
          after = await observe().catch(() => null);
          if (after === null) await Bun.sleep(300);
        }
        expect(after !== null && shows(after, "Verify")).toBe(true);
        expect(heldFrames()).toEqual(expect.arrayContaining(["widget", ...PAGE_FRAMES]));
      },
      true,
    );
  },
  90_000,
);

e2e(
  "an action right after an observation works when a password manager's menu ends the tab's debugging in between",
  async () => {
    await withFixture("src", async ({ observe, act }) => {
      let observation = await observe();
      // The page focuses its field a moment after this click.
      const arm = await act(observation, {
        type: "click",
        locator: ref(observation, "button", "Focus the email field"),
      });
      expect(arm.state).toBe("completed");
      observation = await observe();
      // Meanwhile the field gets focus, the menu appears, and Chrome ends the
      // tab's debugging; the page itself is unchanged.
      await Bun.sleep(2_000);
      const send = await act(observation, {
        type: "click",
        locator: ref(observation, "button", "Send code"),
      });
      expect(send.error?.code).not.toBe("target_stale");
      expect(["completed", "outcome_unknown"]).toContain(send.state);
      observation = await observe();
      expect(shows(observation, "Verify")).toBe(true);
    });
  },
  90_000,
);

// The adapter Opengeni's e2b backend uses (E2BSandboxClient from
// @openai/agents-extensions 0.14.3), built with the options that backend
// passes, through a session as an Opengeni turn drives it: create with a
// manifest, run commands, a PTY, files through the editor, an exposed port,
// persist and hydrate the workspace as a tar, serialize the session, end the
// turn, let the sandbox pause as its timeout would, resume the session from
// its serialized state, and delete it. The backend sets no pauseOnExit, so
// only the timeout pauses its sandboxes, and delete kills them.
//
// Native snapshots (workspacePersistence "snapshot") are left out: the front
// door does not offer E2B snapshots.
import { Manifest } from "@openai/agents-core/sandbox";
import { E2BSandboxClient } from "@openai/agents-extensions/sandbox/e2b";
import { Sandbox } from "e2b";
import { check, expect, finish } from "./check.mjs";

const suite = "adapter";
const run = (name, fn) => check(suite, name, fn);
const text = (data) => (typeof data === "string" ? data : new TextDecoder().decode(data));

// As the backend's build() makes it from Opengeni's settings.
const client = new E2BSandboxClient({
  env: { OG_ADAPTER: "yes" },
  exposedPorts: [8000],
  template: "base",
  timeout: 600,
  timeoutAction: "pause",
  allowInternetAccess: true,
  autoResume: true,
  workspacePersistence: "tar",
});
const manifest = new Manifest({
  root: "/home/user/workspace",
  entries: { "README.md": { type: "file", content: "# conformance\n" } },
});

const session = await run("create with a manifest", async () => client.create(manifest));
if (!session) finish(suite);
const id = session.state.sandboxId;

await run("execCommand in the workspace, with the client's environment", async () => {
  const out = await session.execCommand({ cmd: "cat README.md && echo $OG_ADAPTER && pwd" });
  expect(out.includes("# conformance") && out.includes("yes") && out.includes("/home/user/workspace"), out.slice(0, 300));
});

await run("execCommand with a tty, then writeStdin", async () => {
  expect(session.supportsPty(), "supportsPty() is false");
  const first = await session.execCommand({ cmd: "bash", tty: true, yieldTimeMs: 500 });
  const match = /session[_ ]?id[^0-9]*(\d+)/i.exec(first);
  expect(match !== null, `no session id in ${first.slice(0, 300)}`);
  const out = await session.writeStdin({
    sessionId: Number(match[1]),
    chars: "echo tty-$((6*7)); exit\n",
    yieldTimeMs: 2_000,
  });
  expect(out.includes("tty-42"), out.slice(0, 300));
});

await run("the editor creates a file, and readFile reads it", async () => {
  const editor = session.createEditor();
  await editor.createFile({ type: "create_file", path: "notes/a.txt", diff: "+alpha\n" });
  const back = await session.readFile({ path: "notes/a.txt" });
  expect(text(back).startsWith("alpha"), "content differs");
});

await run("resolveExposedPort reaches a server in the sandbox", async () => {
  await session.execCommand({ cmd: "(python3 -m http.server 8000 >/tmp/http.log 2>&1 &) ; sleep 1" });
  const endpoint = await session.resolveExposedPort(8000);
  const host = typeof endpoint === "string" ? endpoint : (endpoint.url ?? `https://${endpoint.host}`);
  const url = host.startsWith("http") ? host : `https://${host}`;
  const response = await fetch(new URL("/README.md", url.endsWith("/") ? url : `${url}/`));
  expect(response.ok, `status ${response.status}`);
  return { url };
});

const archive = await run("persistWorkspace makes a tar", async () => session.persistWorkspace());

const serialized = await run("serializeSessionState", async () => client.serializeSessionState(session.state));

await run("the turn ends, and the sandbox pauses as on its timeout", async () => {
  await session.shutdown({ reason: "cleanup", preserveOwnedSessions: true });
  expect(await Sandbox.pause(id), "pause answered false");
  const info = await Sandbox.getInfo(id);
  expect(info.state === "paused", `state ${info.state}`);
});

if (serialized) {
  const state = await client.deserializeSessionState(serialized);
  const resumed = await run("resume from the serialized state", async () => client.resume(state));
  if (resumed) {
    await run("the resumed sandbox is the same one, with its files", async () => {
      expect(resumed.state.sandboxId === id, `${resumed.state.sandboxId} is not ${id}`);
      expect(text(await resumed.readFile({ path: "notes/a.txt" })).startsWith("alpha"), "content differs");
    });
    if (archive) {
      await run("hydrateWorkspace restores the persisted tar", async () => {
        await resumed.execCommand({ cmd: "rm -rf notes" });
        await resumed.hydrateWorkspace(archive);
        expect(text(await resumed.readFile({ path: "notes/a.txt" })).startsWith("alpha"), "content differs");
      });
    }
    await run("delete removes it", async () => {
      await resumed.delete();
      const gone = await Sandbox.getInfo(id).then(
        (info) => info.state === "killing",
        () => true,
      );
      expect(gone, "still there");
    });
  }
}

finish(suite);

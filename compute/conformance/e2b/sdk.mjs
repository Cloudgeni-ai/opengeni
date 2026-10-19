// The unchanged E2B JS SDK 2.56.0 against the front door: lifecycle,
// commands, PTYs, files and signed file URLs, ports, pausing, resuming and
// waking on traffic, timeouts, and what keeps a sandbox awake. Records the
// SDK's create, connect and resume latency and envd's memory per guest.
//
// With CONFORMANCE_PART=headers (and E2B_SANDBOX_URL set) only the core
// runs, routed by the E2b-Sandbox-Id and E2b-Sandbox-Port headers to one
// address, as Opengeni can configure it.
import { CommandExitError, NotFoundError, Sandbox } from "e2b";
import { check, expect, finish, level, median, sleep, sleepTo, untilLevel } from "./check.mjs";

const headers = process.env.CONFORMANCE_PART === "headers";
const suite = headers ? "headers" : "sdk";
const run = (name, fn) => check(suite, name, fn);
const measured = {};
const text = (data) => new TextDecoder().decode(data);

// What the guest of `box` says about a server that never answered on
// `port`: what listens, how long naming its own address takes (Python's
// http.server does that before it listens), and whether names resolve
// and connections go out at all.
async function serverReport(box, port) {
  const script = [
    "timeout 5 ss -ltn",
    "cat /etc/resolv.conf",
    `s=$(date +%s%N); timeout 30 python3 -c 'import socket; print(socket.getfqdn("::"))'; echo getfqdn $? $(( ($(date +%s%N) - s) / 1000000 )) ms`,
    "s=$(date +%s%N); timeout 10 getent hosts example.com; echo getent $? $(( ($(date +%s%N) - s) / 1000000 )) ms",
    "if timeout 10 bash -c 'exec 3<>/dev/tcp/1.1.1.1/80'; then echo connect ok; else echo connect-failed; fi",
  ].join("\n");
  try {
    const result = await box.commands.run(script, { timeoutMs: 90_000 });
    return `port ${port}: the guest says ${JSON.stringify(result.stdout + result.stderr)}`;
  } catch (error) {
    return `port ${port}: the guest's report failed: ${String(error).slice(0, 2000)}`;
  }
}

const sandbox = await run("create base with envs, metadata and pause with auto-resume", async () =>
  Sandbox.create("base", {
    timeoutMs: 600_000,
    envs: { CONFORMANCE: "hello" },
    metadata: { suite },
    allowInternetAccess: true,
    lifecycle: { onTimeout: "pause", autoResume: true },
  }),
);
if (!sandbox) finish(suite, measured);
const id = sandbox.sandboxId;

await run("getInfo reports it running with its template and metadata", async () => {
  const info = await sandbox.getInfo();
  expect(info.state === "running", `state ${info.state}`);
  expect(info.templateId === "base" && info.metadata.suite === suite, JSON.stringify(info));
  return { envdVersion: info.envdVersion, cpuCount: info.cpuCount, memoryMB: info.memoryMB };
});

await run("commands.run sees the create's environment", async () => {
  const result = await sandbox.commands.run("echo $CONFORMANCE");
  expect(result.stdout.trim() === "hello", JSON.stringify(result.stdout));
});

await run("commands.run with cwd and its own environment", async () => {
  const result = await sandbox.commands.run("pwd; echo $OWN", { cwd: "/tmp", envs: { OWN: "x1" } });
  expect(result.stdout.trim() === "/tmp\nx1", JSON.stringify(result.stdout));
});

await run("a failing command raises CommandExitError with its code and stderr", async () => {
  try {
    await sandbox.commands.run("echo out; echo err >&2; exit 7");
  } catch (error) {
    expect(error instanceof CommandExitError && error.exitCode === 7, String(error));
    expect(error.stderr.includes("err"), JSON.stringify(error.stderr));
    return;
  }
  throw new Error("no error");
});

await run("commands.run as root and as the default user", async () => {
  const root = (await sandbox.commands.run("id -un", { user: "root" })).stdout.trim();
  const user = (await sandbox.commands.run("id -un")).stdout.trim();
  expect(root === "root" && user === "user", `${root} ${user}`);
});

await run("a command's stdout streams in chunks", async () => {
  const chunks = [];
  await sandbox.commands.run("for i in 1 2 3; do echo line$i; sleep 0.3; done", {
    onStdout: (data) => chunks.push(data),
  });
  expect(chunks.length >= 2 && chunks.join("").includes("line3"), JSON.stringify(chunks));
  return { chunks: chunks.length };
});

await run("files write and read, text and 1 MiB binary", async () => {
  await sandbox.files.write("/tmp/c/a.txt", "alpha\n");
  expect((await sandbox.files.read("/tmp/c/a.txt")) === "alpha\n", "text differs");
  const bytes = new Uint8Array(1 << 20).map((_, i) => (i * 31 + 7) & 0xff);
  await sandbox.files.write("/tmp/c/blob.bin", bytes.buffer);
  const back = await sandbox.files.read("/tmp/c/blob.bin", { format: "bytes" });
  expect(back.length === bytes.length && back.every((b, i) => b === bytes[i]), "bytes differ");
});

await run("pty create, input, resize and kill", async () => {
  let output = "";
  const pty = await sandbox.pty.create({
    cols: 80,
    rows: 24,
    onData: (data) => (output += text(data)),
  });
  await sandbox.pty.sendInput(pty.pid, new TextEncoder().encode("echo pty-$((6*7)); stty size\n"));
  await sandbox.pty.resize(pty.pid, { cols: 100, rows: 30 });
  await sandbox.pty.sendInput(pty.pid, new TextEncoder().encode("stty size\n"));
  for (let i = 0; i < 100 && !output.includes("30 100"); i += 1) await sleep(100);
  expect(
    output.includes("pty-42") && output.includes("30 100"),
    JSON.stringify(output.slice(-300)),
  );
  expect(await sandbox.pty.kill(pty.pid), "kill answered false");
});

if (headers) {
  await run("kill", async () => expect(await sandbox.kill(), "kill answered false"));
  finish(suite, measured);
}

await run("files list, exists, getInfo, rename, remove and makeDir", async () => {
  expect(await sandbox.files.makeDir("/tmp/c/d/e"), "makeDir answered false");
  expect(
    !(await sandbox.files.makeDir("/tmp/c/d/e")),
    "makeDir of an existing directory answered true",
  );
  const names = (await sandbox.files.list("/tmp/c")).map((entry) => entry.name).sort();
  expect(JSON.stringify(names) === '["a.txt","blob.bin","d"]', JSON.stringify(names));
  expect(
    (await sandbox.files.list("/tmp/c", { depth: 2 })).some((e) => e.name === "e"),
    "depth 2",
  );
  const info = await sandbox.files.getInfo("/tmp/c/blob.bin");
  expect(info.size === 1 << 20 && info.type === "file", JSON.stringify(info));
  await sandbox.files.rename("/tmp/c/a.txt", "/tmp/c/b.txt");
  expect(await sandbox.files.exists("/tmp/c/b.txt"), "renamed file missing");
  expect(!(await sandbox.files.exists("/tmp/c/a.txt")), "old name still there");
  await sandbox.files.remove("/tmp/c/b.txt");
  await sandbox.files.remove("/tmp/c/d");
  expect(!(await sandbox.files.exists("/tmp/c/d")), "directory not removed");
});

await run("watchDir reports a file written", async () => {
  const events = [];
  const watch = await sandbox.files.watchDir("/tmp/c", (event) => events.push(event));
  await sandbox.files.write("/tmp/c/watched.txt", "w");
  for (let i = 0; i < 50 && !events.some((e) => e.name === "watched.txt"); i += 1) await sleep(100);
  await watch.stop();
  expect(
    events.some((e) => e.name === "watched.txt"),
    JSON.stringify(events),
  );
});

await run("signed upload and download URLs work without other credentials", async () => {
  const upload = await sandbox.uploadUrl("/tmp/c/signed.txt", { useSignatureExpiration: 120 });
  const form = new FormData();
  form.append("file", new Blob(["signed-body"]), "signed.txt");
  const put = await fetch(upload, { method: "POST", body: form });
  expect(put.ok, `upload ${put.status} ${await put.text()}`);
  const download = await sandbox.downloadUrl("/tmp/c/signed.txt", { useSignatureExpiration: 120 });
  const got = await fetch(download);
  expect(got.ok && (await got.text()) === "signed-body", `download ${got.status}`);
  const unsigned = await fetch(download.replace(/signature=[^&]+/, "signature=v1_wrong"));
  expect(
    unsigned.status === 401 || unsigned.status === 403,
    `a wrong signature got ${unsigned.status}`,
  );
});

await run("envd refuses a request without the sandbox's access token", async () => {
  const url = `https://${sandbox.getHost(49983)}/files?path=/etc/hostname`;
  const refused = await fetch(url);
  expect(refused.status === 401, `without the token: ${refused.status}`);
  const allowed = await fetch(url, { headers: { "X-Access-Token": sandbox.envdAccessToken } });
  expect(allowed.ok, `with the token: ${allowed.status}`);
});

await run("getHost reaches a server in the sandbox, publicly", async () => {
  // envd ends a command at its timeout (60 s unless set), so a server runs
  // with none; its stream is let go, so it does not keep the sandbox awake.
  const server = await sandbox.commands.run("python3 -m http.server 8000 --directory /tmp/c", {
    background: true,
    timeoutMs: 0,
  });
  await server.disconnect();
  const url = `https://${sandbox.getHost(8000)}/blob.bin`;
  for (let i = 0; ; i += 1) {
    const response = await fetch(url).catch((error) => ({ ok: false, status: String(error) }));
    if (response.ok) {
      expect((await response.arrayBuffer()).byteLength === 1 << 20, "wrong length");
      return { tries: i + 1 };
    }
    if (i > 40) throw new Error(`status ${response.status}; ${await serverReport(sandbox, 8000)}`);
    await sleep(250);
  }
});

await run("envd's memory in the guest", async () => {
  const rss = await sandbox.commands.run("grep VmRSS /proc/$(pidof envd)/status", { user: "root" });
  const kib = Number(/(\d+)/.exec(rss.stdout)[1]);
  const used = await sandbox.commands.run("free -k | awk '/Mem:/ {print $3}'");
  measured.envdRssMiB = kib / 1024;
  measured.guestUsedMiB = Number(used.stdout.trim()) / 1024;
  return { envdRssMiB: measured.envdRssMiB, guestUsedMiB: measured.guestUsedMiB };
});

await run("a private sandbox's ports need the traffic token", async () => {
  const closed = await Sandbox.create("base", { network: { allowPublicTraffic: false } });
  try {
    expect(typeof closed.trafficAccessToken === "string", "no traffic token returned");
    await closed.commands.run("python3 -m http.server 8001 --directory /", { background: true });
    const url = `https://${closed.getHost(8001)}/`;
    let open;
    for (let i = 0; i < 40; i += 1) {
      open = await fetch(url, {
        headers: { "e2b-traffic-access-token": closed.trafficAccessToken },
      });
      if (open.ok) break;
      await sleep(250);
    }
    if (!open.ok)
      throw new Error(`with the token: ${open.status}; ${await serverReport(closed, 8001)}`);
    const refused = await fetch(url);
    expect(refused.status === 403, `without the token: ${refused.status}`);
  } finally {
    await closed.kill();
  }
});

await run("an open command stream keeps the sandbox awake", async () => {
  // The host pauses a sandbox ten seconds after its last use.
  const result = await sandbox.commands.run("sleep 25; echo held", { timeoutMs: 60_000 });
  expect(result.stdout.trim() === "held", JSON.stringify(result.stdout));
  const now = level(id);
  expect(now === "running", `level ${now} right after a 25 s stream`);
});

await run("a background command alone does not keep it awake", async () => {
  const background = await sandbox.commands.run("sleep 600", { background: true });
  await background.disconnect();
  // The host's own idle rules decide when (ten seconds idle, and a guest
  // busy on processor or disk counts as used); the stream must not hold it.
  const start = performance.now();
  const reached = await untilLevel(id, ["paused", "compressed", "saved"], 120_000);
  measured.backgroundAsleepAfterMs = Math.round(performance.now() - start);
  const list = await sandbox.commands.list();
  expect(
    list.some((p) => p.pid === background.pid),
    "the background command is gone",
  );
  return { reached, ms: measured.backgroundAsleepAfterMs };
});

await run("traffic wakes a sandbox the host saved to disk", async () => {
  await sleepTo(id, "saved");
  await untilLevel(id, ["saved"], 60_000);
  const start = performance.now();
  const result = await sandbox.commands.run("cat /tmp/c/signed.txt");
  measured.wakeFromSavedMs = Math.round(performance.now() - start);
  expect(result.stdout === "signed-body", JSON.stringify(result.stdout));
  const response = await fetch(`https://${sandbox.getHost(8000)}/signed.txt`);
  expect(response.ok, `the server after the wake: ${response.status} ${await response.text()}`);
  return { ms: measured.wakeFromSavedMs };
});

await run("setTimeout moves the end", async () => {
  const before = (await sandbox.getInfo()).endAt.getTime();
  await sandbox.setTimeout(900_000);
  const after = (await sandbox.getInfo()).endAt.getTime();
  expect(after > before, `end ${before} -> ${after}`);
});

await run("pause is complete when it answers, and the sandbox reads as paused", async () => {
  const start = performance.now();
  expect(await sandbox.pause(), "pause answered false");
  measured.pauseMs = Math.round(performance.now() - start);
  const info = await Sandbox.getInfo(id);
  expect(info.state === "paused", `state ${info.state}`);
  expect(["saved", "archived", "remote"].includes(level(id)), `host level ${level(id)}`);
  return { ms: measured.pauseMs };
});

const resumed = await run(
  "connect resumes it, keeping files, processes and the token",
  async () => {
    const start = performance.now();
    const again = await Sandbox.connect(id, { timeoutMs: 600_000 });
    measured.resumeMs = Math.round(performance.now() - start);
    expect((await again.getInfo()).state === "running", "not running after connect");
    expect((await again.files.read("/tmp/c/signed.txt")) === "signed-body", "file lost");
    const processes = await again.commands.list();
    expect(
      processes.some((p) => [p.cmd, ...(p.args ?? [])].join(" ").includes("sleep 600")),
      `process lost: ${JSON.stringify(processes.map((p) => [p.cmd, p.args]))}`,
    );
    const refused = await fetch(`https://${again.getHost(49983)}/files?path=/etc/hostname`);
    expect(refused.status === 401, `envd without the token after resume: ${refused.status}`);
    return again;
  },
);

await run("traffic to a paused sandbox with auto-resume resumes it", async () => {
  const handle = resumed ?? sandbox;
  await handle.pause();
  const start = performance.now();
  const result = await handle.commands.run("echo woke");
  measured.autoResumeMs = Math.round(performance.now() - start);
  expect(result.stdout.trim() === "woke", JSON.stringify(result.stdout));
  expect((await Sandbox.getInfo(id)).state === "running", "still paused");
  return { ms: measured.autoResumeMs };
});

await run("traffic to a paused sandbox without auto-resume is refused until connect", async () => {
  const still = await Sandbox.create("base", {
    lifecycle: { onTimeout: "pause", autoResume: false },
  });
  try {
    await still.files.write("/tmp/kept.txt", "kept");
    await still.pause();
    const refused = await still.commands.run("echo no").then(
      () => false,
      () => true,
    );
    expect(refused, "a command reached a paused sandbox");
    expect((await Sandbox.getInfo(still.sandboxId)).state === "paused", "traffic resumed it");
    const again = await Sandbox.connect(still.sandboxId);
    expect((await again.files.read("/tmp/kept.txt")) === "kept", "file lost");
  } finally {
    await Sandbox.kill(still.sandboxId);
  }
});

await run("a timeout with onTimeout pause pauses, and connect brings it back", async () => {
  const short = await Sandbox.create("base", {
    timeoutMs: 10_000,
    lifecycle: { onTimeout: "pause" },
  });
  await short.files.write("/tmp/kept.txt", "kept");
  const deadline = Date.now() + 90_000;
  while ((await Sandbox.getInfo(short.sandboxId)).state !== "paused") {
    expect(Date.now() < deadline, "not paused 90 s after a 10 s timeout");
    await sleep(1_000);
  }
  const again = await Sandbox.connect(short.sandboxId);
  expect((await again.files.read("/tmp/kept.txt")) === "kept", "file lost");
  await again.kill();
});

await run("a timeout without pausing kills it", async () => {
  const short = await Sandbox.create("base", { timeoutMs: 8_000 });
  const deadline = Date.now() + 60_000;
  for (;;) {
    const gone = await Sandbox.getInfo(short.sandboxId).then(
      () => false,
      (error) => error instanceof NotFoundError,
    );
    if (gone) return;
    expect(Date.now() < deadline, "still there 60 s after an 8 s timeout");
    await sleep(1_000);
  }
});

await run("the minimal image without bash runs commands and files", async () => {
  const minimal = await Sandbox.create("minimal");
  try {
    const result = await minimal.commands.run("busybox | head -1; id -un; pwd");
    expect(result.stdout.includes("BusyBox") && result.stdout.includes("user"), result.stdout);
    await minimal.files.write("/home/user/m.txt", "m");
    expect((await minimal.files.read("/home/user/m.txt")) === "m", "file differs");
  } finally {
    await minimal.kill();
  }
});

await run("list shows running and paused sandboxes, filtered by metadata", async () => {
  const items = await Sandbox.list({ query: { metadata: { suite } } }).nextItems();
  expect(
    items.some((s) => s.sandboxId === id),
    `ids ${items.map((s) => s.sandboxId)}`,
  );
  return { count: items.length };
});

await run("create, first command and connect latency", async () => {
  const creates = [];
  const firsts = [];
  const connects = [];
  for (let i = 0; i < 5; i += 1) {
    let start = performance.now();
    const fresh = await Sandbox.create("base");
    creates.push(performance.now() - start);
    await fresh.commands.run("true");
    firsts.push(performance.now() - start);
    start = performance.now();
    await Sandbox.connect(fresh.sandboxId);
    connects.push(performance.now() - start);
    await fresh.kill();
  }
  measured.createMs = creates.map(Math.round);
  measured.createToFirstCommandMs = firsts.map(Math.round);
  measured.connectRunningMs = connects.map(Math.round);
  return {
    createMedianMs: Math.round(median(creates)),
    firstCommandMedianMs: Math.round(median(firsts)),
    connectMedianMs: Math.round(median(connects)),
  };
});

await run("kill, and then the sandbox is not found", async () => {
  expect(await Sandbox.kill(id), "kill answered false");
  const gone = await Sandbox.getInfo(id).then(
    () => false,
    (error) => error instanceof NotFoundError,
  );
  expect(gone, "still found");
  expect(!(await Sandbox.kill(id)), "a second kill answered true");
});

finish(suite, measured);

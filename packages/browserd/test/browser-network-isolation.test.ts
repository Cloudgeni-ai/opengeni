import { describe, expect, test } from "bun:test";
import {
  BROWSER_NAMESPACE_DNS,
  BROWSER_SHARED_NETWORK_NOTICE,
  browserNetworkIsolationScript,
  isolatedChromeLaunch,
  namespaceResolvConf,
  pastaArguments,
  type BrowserNetworkIsolationTools,
} from "../src/browser-network-isolation";

const tools: BrowserNetworkIsolationTools = {
  pasta: "/opt/passt/pasta",
  unshare: "/usr/bin/unshare",
  setsid: "/usr/bin/setsid",
  shell: "/bin/sh",
  sleep: "/usr/bin/sleep",
  rm: "/usr/bin/rm",
  mv: "/usr/bin/mv",
  cat: "/usr/bin/cat",
  mount: "/usr/bin/mount",
  uid: 1000,
  gid: 100,
};

describe("browser network isolation", () => {
  test("points DNS at pasta's forwarder only when the host resolver is on loopback", () => {
    expect(
      namespaceResolvConf(
        "# stub\nsearch corp.example\nnameserver 127.0.0.53\noptions edns0 trust-ad\n",
      ),
    ).toBe(
      `nameserver ${BROWSER_NAMESPACE_DNS}\n# stub\nsearch corp.example\noptions edns0 trust-ad\n`,
    );
    expect(namespaceResolvConf("nameserver ::1\nnameserver 192.0.2.1\n")).toBe(
      `nameserver ${BROWSER_NAMESPACE_DNS}\n`,
    );
    // A resolver the namespace reaches through pasta needs no override.
    expect(namespaceResolvConf("nameserver 100.100.100.100\nnameserver 127.0.0.1\n")).toBeNull();
    expect(namespaceResolvConf("search corp.example\n")).toBeNull();
  });

  test("pasta gets its own address, the DevTools port and host loopback servers", () => {
    const argumentsList = pastaArguments(tools, 41234);
    expect(argumentsList[0]).toBe(tools.pasta);
    // Never copy the host's own address into the namespace.
    expect(argumentsList).toContain("169.254.83.2");
    expect(argumentsList.join(" ")).toContain("--host-lo-to-ns-lo --tcp-ports 127.0.0.1/41234");
    // Every port, including ephemeral ones a bare "auto" leaves out.
    expect(argumentsList.join(" ")).toContain("--tcp-ns auto,1-65535");
  });

  test("the launch maps back to the person's UID and pins the DevTools port", () => {
    const script = browserNetworkIsolationScript({
      tools,
      wrapper: "/state/chrome-launch/id.sh",
      stateDirectory: "/state/chrome-launch/id.d",
      cdpPort: 41234,
      resolvOverride: "/state/chrome-launch/id.resolv.conf",
      prologue: "# scope entry",
      launch: isolatedChromeLaunch({
        tools,
        cdpPort: 41234,
        executable: "/usr/lib/chromium/chromium",
        fixedArguments: ["--user-agent=Mozilla/5.0 (X11, Linux)"],
        trailingArguments: ["--disable-features=A,B"],
        stderrFifo: "/state/chrome-launch/id.stderr.fifo",
        stderrLog: "/state/chrome-launch/chrome-stderr.log",
        tail: "/usr/bin/tail",
        stderrBytes: 65_536,
      }),
    });
    // The scope prologue runs before any namespace is entered.
    expect(script.indexOf("# scope entry")).toBeLessThan(script.indexOf("--map-root-user"));
    expect(script).toContain("'/usr/bin/unshare' --user --map-root-user --net --mount --");
    expect(script).toContain("--user --map-user=1000 --map-group=100 --");
    expect(script).toContain("/proc/sys/net/ipv6/conf/all/accept_dad");
    // Loopback keeps IPv6, so servers listening only on ::1 stay reachable.
    expect(script).not.toContain("disable_ipv6");
    // Chrome starts only after each address's solicited-node group is joined,
    // so the kernel's late address announcement cannot drop its connections.
    const settle = script.indexOf("</proc/net/igmp6");
    expect(settle).toBeGreaterThan(script.indexOf(".net-ready"));
    expect(settle).toBeLessThan(script.indexOf("--map-user=1000"));
    expect(script).toContain("group=ff0200000000000000000001ff${address#");
    expect(script).toContain(
      "'/usr/bin/mount' --bind '/state/chrome-launch/id.resolv.conf' /etc/resolv.conf",
    );
    expect(script).toContain("--remote-debugging-port=41234");
    expect(script).toContain(
      "exec '/usr/lib/chromium/chromium' '--user-agent=Mozilla/5.0 (X11, Linux)' \"$@\" '--disable-features=A,B' 2>'/state/chrome-launch/id.stderr.fifo'",
    );
  });

  test("the shared-network notice is one plain line", () => {
    expect(BROWSER_SHARED_NETWORK_NOTICE).not.toContain("\n");
    expect(BROWSER_SHARED_NETWORK_NOTICE).not.toMatch(/namespace|pasta|sandbox/iu);
  });
});

test.skipIf(process.platform !== "linux")(
  "a machine without isolation launches as before and reports the shared network",
  async () => {
    const child = Bun.spawn(
      [process.execPath, "-e", fallbackFixture, new URL("../src/runner.ts", import.meta.url).href],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]).finally(() => clearTimeout(timer));
    expect({ stdout: stdout.trim(), stderr: stderr.trim(), exit }).toEqual({
      stdout: "plain launch with notice",
      stderr: "",
      exit: 0,
    });
  },
  15_000,
);

const fallbackFixture = `
import { mock } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
const isolation = new URL("./browser-network-isolation.ts", process.argv[1]).href;
const actual = await import(isolation);
mock.module(isolation, () => ({
  ...actual,
  linuxBrowserNetworkIsolation: async () => ({ kind: "unavailable", reason: "pasta is not installed" }),
}));
const { ManagedBrowserRunner } = await import(process.argv[1]);
const root = await mkdtemp("/tmp/og-netns-fallback-");
const browserPath = join(root, "chrome");
await writeFile(browserPath, "#!/bin/sh\\nexit 0\\n", { mode: 0o700 });
let runner;
try {
  runner = await ManagedBrowserRunner.create({ profileDirectory: join(root, "profile"),
    headed: true, systemdScope: false, browserExecutablePath: browserPath,
  });
  assert.equal(runner.networkNotice, actual.BROWSER_SHARED_NETWORK_NOTICE);
  const launch = join(root, "chrome-launch");
  const wrapper = (await readdir(launch)).find((name) => name.endsWith(".sh"));
  assert.ok(wrapper);
  assert.ok(!(await readFile(join(launch, wrapper), "utf8")).includes("unshare"));
  console.log("plain launch with notice");
} finally {
  if (runner) await runner.terminate();
  await rm(root, { recursive: true, force: true });
}
`;

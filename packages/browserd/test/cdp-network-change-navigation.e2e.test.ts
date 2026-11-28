import { expect, test } from "bun:test";
import { join } from "node:path";

// A navigation the browser cancelled because the machine's network changed
// (net::ERR_NETWORK_CHANGED) loads once more, as the browser's own error page
// would, instead of leaving the tab on the error page with an unknown
// outcome. The probe runs in a private user + network namespace whose root
// changes an interface address while the browser is still connecting.
const e2e =
  process.platform === "linux" && process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

e2e(
  "a navigation cancelled by a network change on the machine loads once more",
  async () => {
    const unshare = Bun.which("unshare");
    const ip = Bun.which("ip") ?? Bun.which("ip", { PATH: "/usr/sbin:/sbin" });
    if (!unshare || !ip) {
      console.warn("skipping: unshare or iproute2 is not installed");
      return;
    }
    const probe = join(import.meta.dir, "fixtures", "network-change-navigation-probe.ts");
    const child = Bun.spawn(
      [unshare, "--user", "--map-root-user", "--net", "--", process.execPath, probe, ip],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: process.env },
    );
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const line = stdout.split("\n").find((entry) => entry.startsWith("{"));
    expect({ exit, outcome: line ? JSON.parse(line) : null }, stderr).toEqual({
      exit: 0,
      // The cancelled load never reached the website; the second one did.
      outcome: { state: "completed", title: "Loaded", requests: 1 },
    });
  },
  120_000,
);

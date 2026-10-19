import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linuxBrowserNetworkIsolation } from "../src/browser-network-isolation";

// Interface churn on the machine (container veths and bridges coming and
// going) must not reach a managed browser. The whole test runs in a private
// user + network namespace that stands in for a busy host: its own root adds
// an address on an unrelated dummy interface while the browser holds an idle
// keep-alive connection to a loopback server. Chromium drops connections on
// every address change it sees, so the shared-network browser must lose the
// connection (proving the churn is observable) and the isolated one keep it.
const e2e =
  process.platform === "linux" && process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

describe("managed browser network isolation", () => {
  e2e(
    "keeps host interface changes away from the browser's connections",
    async () => {
      const isolation = await linuxBrowserNetworkIsolation();
      if (isolation.kind !== "isolated") {
        console.warn(`skipping: browser network isolation unavailable (${isolation.reason})`);
        return;
      }
      const ip = Bun.which("ip");
      if (!ip) {
        console.warn("skipping: iproute2 is not installed");
        return;
      }
      const directory = await mkdtemp(join(tmpdir(), "og-network-churn-"));
      const probe = join(import.meta.dir, "fixtures", "network-churn-probe.ts");
      const harness = [
        "set -eu",
        `ip=${shellQuote(ip)} directory=${shellQuote(directory)}`,
        '"$ip" link set lo up',
        '"$ip" link add up0 type dummy && "$ip" link set up0 up',
        '"$ip" addr add 192.0.2.10/24 dev up0 && "$ip" route add default via 192.0.2.1',
        "n=0",
        "for mode in shared isolated; do",
        "  n=$((n + 1))",
        '  rm -f "$directory/ready" "$directory/churned"',
        `  ${shellQuote(isolation.tools.unshare)} --user --map-user=${isolation.tools.uid} --map-group=${isolation.tools.gid} -- ${shellQuote(process.execPath)} ${shellQuote(probe)} "$mode" "$directory" &`,
        "  child=$!",
        "  i=0",
        '  while [ ! -e "$directory/ready" ]; do',
        '    i=$((i + 1)); [ "$i" -gt 1200 ] && { kill "$child"; exit 1; }',
        '    kill -0 "$child" 2>/dev/null || break',
        "    sleep 0.05",
        "  done",
        '  "$ip" link add "churn$n" type dummy && "$ip" link set "churn$n" up',
        '  "$ip" addr add "10.99.$n.1/24" dev "churn$n"',
        '  : >"$directory/churned"',
        '  wait "$child"',
        "done",
      ].join("\n");
      try {
        const child = Bun.spawn(
          [
            isolation.tools.unshare,
            "--user",
            "--map-root-user",
            "--net",
            "--",
            isolation.tools.shell,
            "-c",
            harness,
          ],
          { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: process.env },
        );
        const [stdout, stderr, exit] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        const results = stdout
          .split("\n")
          .filter((line) => line.startsWith("{"))
          .map((line) => JSON.parse(line) as { mode: string; keptConnection: boolean });
        expect({ exit, results }, stderr).toEqual({
          exit: 0,
          results: [
            { mode: "shared", notice: null, keptConnection: false },
            { mode: "isolated", notice: null, keptConnection: true },
          ],
        } as never);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    120_000,
  );

  e2e(
    "reaches every host loopback server the shared-network browser reaches",
    async () => {
      const isolation = await linuxBrowserNetworkIsolation();
      if (isolation.kind !== "isolated") {
        console.warn(`skipping: browser network isolation unavailable (${isolation.reason})`);
        return;
      }
      const probe = join(import.meta.dir, "fixtures", "network-reachability-probe.ts");
      const run = async (mode: "shared" | "isolated") => {
        const child = Bun.spawn([process.execPath, probe, mode], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          env: process.env,
        });
        const [stdout, stderr, exit] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        const line = stdout.split("\n").find((entry) => entry.startsWith("{"));
        expect({ exit, parsed: line !== undefined }, stderr).toEqual({ exit: 0, parsed: true });
        return JSON.parse(line!) as { notice: string | null; results: Record<string, string> };
      };
      const shared = await run("shared");
      const isolated = await run("isolated");
      // What localhost does on the host itself: a server answers on the
      // families it listens on, and localhost falls back to the one that works.
      const expected: Record<string, string> = {};
      for (const when of ["before", "after"]) {
        for (const [shape, ipv4, ipv6] of [
          ["ipv4", "loads", "fails"],
          ["ipv6", "fails", "loads"],
          ["any4", "loads", "fails"],
          ["dual", "loads", "loads"],
        ] as const) {
          expected[`${shape} ${when} via localhost`] = "loads";
          expected[`${shape} ${when} via 127.0.0.1`] = ipv4;
          expected[`${shape} ${when} via [::1]`] = ipv6;
        }
      }
      expect(shared.results).toEqual(expected);
      expect({ notice: isolated.notice, results: isolated.results }).toEqual({
        notice: null,
        results: expected,
      });
    },
    120_000,
  );
});

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

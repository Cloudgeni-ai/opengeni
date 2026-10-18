import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Managed Linux Chrome runs in its own network namespace, reached through
 * pasta (passt's userspace network stack).
 *
 * Chromium's Linux network-change notifier watches every interface on the
 * machine. Each address added or removed anywhere (a container's veth or
 * bridge, a VPN) counts as a network change, and Chromium then closes every
 * HTTP/2 and QUIC session with ERR_NETWORK_CHANGED, killing requests in
 * flight. Inside its own namespace the browser sees only its own interface,
 * while its traffic still leaves through ordinary host sockets: external
 * sites, VPN and container addresses, the machine's own addresses and its
 * loopback servers all stay reachable, and real failures stay failures.
 *
 * Launch sequence (one shell wrapper that re-executes itself; the PID the
 * driver spawned stays the browser's PID throughout):
 *  0. Start a detached helper, then enter a new user + network namespace as
 *     namespace root.
 *  1. As namespace root, turn off IPv6 duplicate-address detection (its late
 *     completion would itself be an address change inside the namespace),
 *     keep loopback IPv4-only (pasta forwards a host loopback port on both
 *     families and connects to the host on the same one, so a wrong-family
 *     connection is accepted and then reset; IPv4 is what nearly every local
 *     server listens on), point DNS at pasta's forwarder when the host's
 *     resolver is a loopback address, then wait for the helper to attach
 *     pasta to this namespace.
 *  2. Enter a nested user namespace that maps back to the person's own UID
 *     (Chrome refuses to run as root and needs a non-root sandbox), then
 *     exec Chrome with its DevTools port pinned to the one pasta forwards.
 */

/** The namespace's own address. Not the host's: a page that loads the
 * machine's own LAN address must reach the machine, not the namespace. */
export const BROWSER_NAMESPACE_ADDRESS = "169.254.83.2";
export const BROWSER_NAMESPACE_GATEWAY = "169.254.83.1";
export const BROWSER_NAMESPACE_PREFIX_LENGTH = 30;
/** pasta answers DNS sent here by forwarding it to the host's resolver. */
export const BROWSER_NAMESPACE_DNS = "169.254.83.53";

/** One plain line for the agent when the browser shares the machine's
 * network because isolation is unavailable there. */
export const BROWSER_SHARED_NETWORK_NOTICE =
  "This browser uses the machine's network directly, so a network change on the machine (for example a container starting or stopping) can make loading pages or requests fail with ERR_NETWORK_CHANGED. If that happens, reload or retry.";

export type BrowserNetworkIsolationTools = {
  pasta: string;
  unshare: string;
  setsid: string;
  shell: string;
  sleep: string;
  rm: string;
  mv: string;
  cat: string;
  mount: string;
  uid: number;
  gid: number;
};

export type BrowserNetworkIsolation =
  | { kind: "isolated"; tools: BrowserNetworkIsolationTools }
  | { kind: "unavailable"; reason: string };

const PROBE_TIMEOUT_MS = 5_000;
const NAMESPACE_READY_POLLS = 500;
const NETWORK_READY_POLLS = 1_000;
const REQUIRED_TOOLS = ["unshare", "setsid", "sleep", "rm", "mv", "cat", "mount"] as const;

/** The one place that chooses which pasta managed browsers use. A pasta
 * shipped with Opengeni would be checked first here; until then the system's
 * own installation is used when present. */
export async function pastaExecutable(): Promise<string | undefined> {
  return (
    (await firstExecutableInPath(["pasta"])) ??
    (await firstExecutable(["/usr/bin/pasta", "/usr/sbin/pasta", "/bin/pasta", "/sbin/pasta"]))
  );
}

let probed: Promise<BrowserNetworkIsolation> | undefined;

/** Whether managed browsers on this machine can run in their own network
 * namespace. Probed once per process with the exact launch sequence (a
 * throwaway namespace with pasta attached), because user namespaces can be
 * present yet restricted, for example by an AppArmor policy. */
export function linuxBrowserNetworkIsolation(): Promise<BrowserNetworkIsolation> {
  probed ??= probeBrowserNetworkIsolation().catch((error: unknown) => ({
    kind: "unavailable" as const,
    reason: error instanceof Error ? error.message : String(error),
  }));
  return probed;
}

async function probeBrowserNetworkIsolation(): Promise<BrowserNetworkIsolation> {
  if (process.platform !== "linux") return { kind: "unavailable", reason: "not Linux" };
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) {
    return { kind: "unavailable", reason: "process identity is unavailable" };
  }
  if (uid === 0) {
    // A root browser runs without Chrome's user-namespace sandbox already;
    // there is no person's UID to map back to.
    return { kind: "unavailable", reason: "the browser runs as root" };
  }
  const pasta = await pastaExecutable();
  if (!pasta) return { kind: "unavailable", reason: "pasta is not installed" };
  const shell = await firstExecutable(["/bin/sh"]);
  const found: Partial<Record<(typeof REQUIRED_TOOLS)[number], string>> = {};
  const missing: string[] = shell ? [] : ["sh"];
  for (const name of REQUIRED_TOOLS) {
    const path =
      (await firstExecutableInPath([name])) ??
      (await firstExecutable([`/usr/bin/${name}`, `/bin/${name}`]));
    if (path) found[name] = path;
    else missing.push(name);
  }
  if (missing.length > 0 || !shell) {
    return { kind: "unavailable", reason: `missing ${missing.join(", ")}` };
  }
  const tools = { pasta, shell, uid, gid, ...found } as BrowserNetworkIsolationTools;
  const directory = await mkdtemp(join(tmpdir(), "opengeni-browser-netns-probe-"));
  try {
    const script = join(directory, "probe.sh");
    await writeFile(
      script,
      browserNetworkIsolationScript({
        tools,
        wrapper: script,
        stateDirectory: directory,
        cdpPort: await freeLoopbackPort(),
        resolvOverride: null,
        launch: "exit 0\n",
      }),
      { mode: 0o700, flag: "wx" },
    );
    const result = await runBounded(tools.shell, [script], PROBE_TIMEOUT_MS);
    if (result.code === 0) return { kind: "isolated", tools };
    return {
      kind: "unavailable",
      reason: result.stderr.trim().split("\n").at(-1) || "the namespace probe failed",
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** The pasta invocation that attaches to the namespace of a PID appended
 * last. */
export function pastaArguments(tools: BrowserNetworkIsolationTools, cdpPort: number): string[] {
  return [
    tools.pasta,
    "--config-net",
    "--quiet",
    "--address",
    BROWSER_NAMESPACE_ADDRESS,
    "--netmask",
    String(BROWSER_NAMESPACE_PREFIX_LENGTH),
    "--gateway",
    BROWSER_NAMESPACE_GATEWAY,
    "--dns-forward",
    BROWSER_NAMESPACE_DNS,
    // Host loopback connections to the DevTools port arrive on the
    // namespace's loopback, where Chrome listens.
    "--host-lo-to-ns-lo",
    "--tcp-ports",
    `127.0.0.1/${cdpPort}`,
    // Servers listening on the host's loopback are reachable from the
    // browser's loopback, including ones started after launch.
    "--tcp-ns",
    "auto",
    "--udp-ports",
    "none",
    "--udp-ns",
    "none",
  ];
}

export type BrowserNetworkIsolationScriptInput = {
  tools: BrowserNetworkIsolationTools;
  /** The script's own path; each stage re-executes it. */
  wrapper: string;
  /** Private directory for this launch's readiness markers. */
  stateDirectory: string;
  cdpPort: number;
  /** A resolv.conf to mount over /etc/resolv.conf inside the namespace. */
  resolvOverride: string | null;
  /** Shell text that runs last, inside the namespace as the person's UID. */
  launch: string;
  /** Shell text that runs first, before entering the namespace. */
  prologue?: string;
};

const STAGE = "OPENGENI_BROWSER_NETNS";
const STAGE_PID = "OPENGENI_BROWSER_NETNS_PID";

/** The complete self-re-executing launch script. */
export function browserNetworkIsolationScript(input: BrowserNetworkIsolationScriptInput): string {
  const { tools } = input;
  const q = shellQuote;
  const state = q(input.stateDirectory);
  const wrapper = q(input.wrapper);
  const marker = (name: string) => `${state}/"$${STAGE_PID}".${name}`;
  const helper = [
    "s=$1 pid=$2 sleep=$3; shift 3",
    "i=0",
    'while [ ! -e "$s/$pid.ns-ready" ]; do',
    '  [ -e "$s/$pid.ns-failed" ] && exit 1',
    `  i=$((i + 1)); [ "$i" -gt ${NAMESPACE_READY_POLLS} ] && exit 1`,
    '  "$sleep" 0.01',
    "done",
    'if "$@" "$pid" 2>"$s/$pid.pasta.err"; then : >"$s/$pid.net-ready"; else : >"$s/$pid.net-failed"; fi',
  ].join("\n");
  const fail = (message: string) =>
    `{ : >${marker("ns-failed")}; echo ${q(`browser network isolation: ${message}`)} >&2; exit 1; }`;
  const stage1Namespaces = input.resolvOverride
    ? "--user --map-root-user --net --mount"
    : "--user --map-root-user --net";
  return [
    "#!/bin/sh",
    "umask 077",
    `if [ -z "\${${STAGE}:-}" ]; then`,
    input.prologue ?? ":",
    `${STAGE_PID}=$$`,
    `${q(tools.setsid)} -f ${q(tools.shell)} -c ${q(helper)} opengeni-browser-network ${state} "$${STAGE_PID}" ${q(tools.sleep)} ${pastaArguments(tools, input.cdpPort).map(q).join(" ")} </dev/null >/dev/null 2>&1`,
    `${STAGE}=1; export ${STAGE} ${STAGE_PID}`,
    `exec ${q(tools.unshare)} ${stage1Namespaces} -- ${q(tools.shell)} ${wrapper} "$@"`,
    "fi",
    `if [ "$${STAGE}" = 1 ]; then`,
    "  if [ -d /proc/sys/net/ipv6/conf/lo ]; then",
    `    { echo 0 >/proc/sys/net/ipv6/conf/default/accept_dad && echo 0 >/proc/sys/net/ipv6/conf/all/accept_dad && echo 1 >/proc/sys/net/ipv6/conf/lo/disable_ipv6; } || ${fail("cannot configure the namespace")}`,
    "  fi",
    input.resolvOverride
      ? `  ${q(tools.mount)} --bind ${q(input.resolvOverride)} /etc/resolv.conf || ${fail("cannot set the namespace's DNS")}`
      : "  :",
    `  : >${marker("ns-ready")}`,
    "  i=0",
    `  while [ ! -e ${marker("net-ready")} ]; do`,
    `    if [ -e ${marker("net-failed")} ]; then`,
    `      while IFS= read -r line; do echo "$line" >&2; done <${marker("pasta.err")}`,
    "      echo 'browser network isolation: pasta could not attach' >&2",
    "      exit 1",
    "    fi",
    `    i=$((i + 1)); [ "$i" -gt ${NETWORK_READY_POLLS} ] && { echo 'browser network isolation: pasta did not attach in time' >&2; exit 1; }`,
    `    ${q(tools.sleep)} 0.01`,
    "  done",
    `  ${STAGE}=2 exec ${q(tools.unshare)} --user --map-user=${tools.uid} --map-group=${tools.gid} -- ${q(tools.shell)} ${wrapper} "$@"`,
    "fi",
    `unset ${STAGE} ${STAGE_PID}`,
    input.launch,
  ].join("\n");
}

/** Shell text that execs Chrome inside the namespace. The DevTools port is
 * pinned to the one pasta forwards. Chrome writes DevToolsActivePort only for
 * an ephemeral port, so a reader of Chrome's stderr writes it, exactly as
 * Chrome would, from the "DevTools listening on" line. The reader is its own
 * process (no copy of the browser's command line), so a process scan for the
 * profile finds only Chrome. */
export function isolatedChromeLaunch(input: {
  tools: BrowserNetworkIsolationTools;
  cdpPort: number;
  executable: string;
  fixedArguments: readonly string[];
  trailingArguments: readonly string[];
  stderrFifo: string;
  stderrLog: string;
  tail: string;
  stderrBytes: number;
}): string {
  const q = shellQuote;
  const port = input.cdpPort;
  const reader = [
    'port=$1 profile=$2 mv=$3 cat=$4 prefix="DevTools listening on ws://127.0.0.1:$1"',
    "while IFS= read -r line; do",
    "  printf '%s\\n' \"$line\"",
    '  case $line in "$prefix"/*)',
    '    if [ -n "$profile" ]; then',
    '      printf \'%s\\n%s\' "$port" "${line#"$prefix"}" >"$profile/.DevToolsActivePort.opengeni" && "$mv" -f "$profile/.DevToolsActivePort.opengeni" "$profile/DevToolsActivePort"',
    "    fi",
    '    exec "$cat";;',
    "  esac",
    "done",
  ].join("\n");
  const fixed = input.fixedArguments.map((argument) => ` ${q(argument)}`).join("");
  const trailing = input.trailingArguments.map((argument) => ` ${q(argument)}`).join("");
  return [
    "profile=",
    "for argument; do",
    "  shift",
    "  case $argument in",
    `    --remote-debugging-port=*) set -- "$@" --remote-debugging-port=${port} ;;`,
    '    --user-data-dir=*) profile=${argument#--user-data-dir=}; set -- "$@" "$argument" ;;',
    '    *) set -- "$@" "$argument" ;;',
    "  esac",
    "done",
    `[ -n "$profile" ] && ${q(input.tools.rm)} -f "$profile/DevToolsActivePort"`,
    `${q(input.tools.shell)} -c ${q(reader)} opengeni-browser-devtools ${port} "$profile" ${q(input.tools.mv)} ${q(input.tools.cat)} <${q(input.stderrFifo)} | ${q(input.tail)} -c ${input.stderrBytes} >${q(input.stderrLog)} 2>/dev/null &`,
    `exec ${q(input.executable)}${fixed} "$@"${trailing} 2>${q(input.stderrFifo)}`,
    "",
  ].join("\n");
}

/** A resolv.conf for the namespace when the host's resolver is a loopback
 * address (systemd-resolved's stub, dnsmasq), which the namespace cannot
 * reach. Queries go to pasta's forwarder instead; search domains and options
 * are kept. Null when the host's own file already works. */
export function namespaceResolvConf(hostResolvConf: string): string | null {
  const lines = hostResolvConf.split("\n");
  const first = lines
    .map((line) => line.trim().split(/\s+/u))
    .find((fields) => fields[0] === "nameserver")?.[1];
  if (!first || !isLoopbackAddress(first)) return null;
  const kept = lines.filter((line) => line.trim().split(/\s+/u)[0] !== "nameserver");
  return `${[`nameserver ${BROWSER_NAMESPACE_DNS}`, ...kept].join("\n").trimEnd()}\n`;
}

export async function hostNamespaceResolvConf(): Promise<string | null> {
  try {
    return namespaceResolvConf(await readFile("/etc/resolv.conf", "utf8"));
  } catch {
    return null;
  }
}

function isLoopbackAddress(address: string): boolean {
  const bare = (address.split("%")[0] ?? "").toLowerCase();
  return /^127\./u.test(bare) || bare === "::1" || bare === "0:0:0:0:0:0:0:1";
}

/** A currently free host loopback port for the browser's DevTools endpoint. */
export async function freeLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port > 0 ? resolvePort(port) : reject(new Error("no free port"))));
    });
  });
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function runBounded(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    if (stderr.length < 16_384) stderr += chunk;
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  timer.unref?.();
  try {
    const code = await new Promise<number | null>((resolveExit) => {
      child.once("error", () => resolveExit(null));
      child.once("close", resolveExit);
    });
    return { code, stderr };
  } finally {
    clearTimeout(timer);
  }
}

async function firstExecutableInPath(names: readonly string[]): Promise<string | undefined> {
  for (const name of names) {
    for (const directory of (process.env.PATH ?? "").split(":")) {
      if (!directory) continue;
      const candidate = join(directory, name);
      try {
        await access(candidate, constants.X_OK);
        return resolve(candidate);
      } catch {
        // Continue to the next installed candidate.
      }
    }
  }
  return undefined;
}

async function firstExecutable(candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return resolve(candidate);
    } catch {
      // Continue to the next known location.
    }
  }
  return undefined;
}

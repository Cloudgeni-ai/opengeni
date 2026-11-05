/**
 * Self-repair of a chat's own workspace machine (a compute box) at turn setup.
 *
 * An agent can set the box's clock or overwrite /etc/resolv.conf with a few
 * shell commands. Both then persist across turns: the compute guest writes
 * resolv.conf only at boot and sets the clock only from resume notices, so a
 * clock left in 2001 or a resolver pointing nowhere breaks TLS, git, ogtool
 * and every other network client in every later turn. Before each turn the
 * worker checks the box against its own (NTP-synced) clock and checks that the
 * box can look up Opengeni's host, and repairs only what is broken:
 *
 * - a clock more than a few minutes off is set to the worker's time, as root;
 * - when Opengeni's host does not resolve, /etc/resolv.conf is restored to the
 *   name servers the platform gave the box on its kernel command line (`ip=`,
 *   the same source the guest uses at boot). The replaced file is kept beside
 *   it. A working resolver is never touched, whatever it contains.
 *
 * Only boxes Opengeni owns get this. A Connected Machine is the person's own
 * computer, whose clock and DNS are theirs; ogtool names the cause there.
 */

/** How far the box clock may drift from the worker's before it is set. */
export const OWNED_BOX_MAX_CLOCK_DRIFT_SECONDS = 300;

/** Where the box's replaced resolv.conf is kept after a repair. */
export const OWNED_BOX_REPLACED_RESOLV_CONF_SUFFIX = ".opengeni-replaced";

const REPORT_PREFIX = "opengeni-box-repair:";

export type OwnedBoxRepairCommandOptions = {
  /** The worker's clock, in whole seconds since the epoch. */
  workerEpochSeconds: number;
  /** Opengeni's host as the box reaches it; null skips the DNS check. */
  host: string | null;
  maxDriftSeconds?: number;
  /** Test seams; production uses the box's real files. */
  resolvConfPath?: string;
  kernelCmdlinePath?: string;
};

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** A plain host name, so it can be passed to the resolver safely. */
function lookupHost(host: string | null): string {
  return host && /^[A-Za-z0-9.-]{1,253}$/u.test(host) ? host : "";
}

/** The host of Opengeni's Codemode URL, which every box tool reaches. */
export function ownedBoxRepairHost(environment: Record<string, string | undefined>): string | null {
  const url = environment.OPENGENI_CODEMODE_URL;
  if (!url) return null;
  try {
    return lookupHost(new URL(url).hostname) || null;
  } catch {
    return null;
  }
}

/**
 * One POSIX shell command that checks and repairs the box, printing one
 * `opengeni-box-repair:` line for each thing it found wrong. It exits 0 unless
 * the shell itself fails, so a box that cannot be repaired never fails setup.
 */
export function ownedBoxRepairCommand(options: OwnedBoxRepairCommandOptions): string {
  const workerEpoch = Math.floor(options.workerEpochSeconds);
  const maxDrift = Math.floor(options.maxDriftSeconds ?? OWNED_BOX_MAX_CLOCK_DRIFT_SECONDS);
  const resolvConf = options.resolvConfPath ?? "/etc/resolv.conf";
  const cmdline = options.kernelCmdlinePath ?? "/proc/cmdline";
  return `
report() { printf '${REPORT_PREFIX} %s\\n' "$*"; }
as_root() {
  if [ "$(id -u 2>/dev/null)" = 0 ]; then "$@"
  elif command -v sudo >/dev/null 2>&1; then sudo -n "$@"
  else return 1; fi
}
# Whether timeout 5 works here (old busybox wants timeout -t 5).
if command -v timeout >/dev/null 2>&1 && timeout 5 true >/dev/null 2>&1; then
  has_timeout=1
else
  has_timeout=
fi
worker_epoch=${workerEpoch}
max_drift=${maxDrift}
host=${shellQuote(lookupHost(options.host))}
resolv=${shellQuote(resolvConf)}
cmdline=${shellQuote(cmdline)}

box_epoch=$(date -u +%s 2>/dev/null)
case "\${box_epoch#-}" in
  ''|*[!0-9]*) ;;
  *)
    drift=$((box_epoch - worker_epoch))
    if [ "$drift" -lt 0 ]; then drift=$((0 - drift)); fi
    if [ "$drift" -gt "$max_drift" ]; then
      if as_root date -u -s "@$worker_epoch" >/dev/null 2>&1; then
        report "clock=set from=$box_epoch to=$worker_epoch"
      else
        report "clock=unset from=$box_epoch to=$worker_epoch"
      fi
    fi
    ;;
esac

# 0: resolves; 1: does not resolve (not found or timed out); 2: cannot tell.
# Only a bounded lookup counts, and only "not found" or "timed out" is a
# failure: any other exit (an unsupported option, a missing program) is not
# evidence that the resolver is broken.
lookup() {
  if [ -n "$has_timeout" ] && command -v getent >/dev/null 2>&1; then
    timeout 5 getent hosts "$host" >/dev/null 2>&1
    case $? in
      0) return 0 ;;
      2|124) return 1 ;;
    esac
  fi
  if command -v node >/dev/null 2>&1; then
    node -e '
      setTimeout(() => process.exit(124), 5000).unref();
      require("dns").lookup(process.argv[1], (error) => {
        if (!error) process.exit(0);
        process.exit(["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "EAI_NODATA", "EAI_NONAME"].includes(error.code) ? 2 : 3);
      });
    ' "$host" >/dev/null 2>&1
    case $? in
      0) return 0 ;;
      2|124) return 1 ;;
    esac
  fi
  return 2
}
if [ -n "$host" ]; then
  lookup
  if [ "$?" = 1 ]; then
    # The last ip= wins, as in the guest's own parser.
    servers=$(tr ' ' '\\n' < "$cmdline" 2>/dev/null | sed -n 's/^ip=//p' | tail -n 1 \\
      | awk -F: '{ print $8; print $9 }' \\
      | grep -E '^[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}$')
    wanted=$(for server in $servers; do printf 'nameserver %s\\n' "$server"; done)
    # True when the file is already just the platform's: every name server is
    # a platform server and no options line can change how they are used. A
    # dead server listed ahead of the platform's, or an option such as a long
    # timeout, is still repaired.
    only_platform_servers() {
      listed=$(sed -n 's/^[[:space:]]*nameserver[[:space:]][[:space:]]*\\([^[:space:]#]*\\).*/\\1/p' "$resolv" 2>/dev/null)
      [ -n "$listed" ] || return 1
      grep -q '^[[:space:]]*options' "$resolv" 2>/dev/null && return 1
      for entry in $listed; do
        known=
        for server in $servers; do
          if [ "$entry" = "$server" ]; then known=1; fi
        done
        [ -n "$known" ] || return 1
      done
      return 0
    }
    if [ -z "$wanted" ]; then
      report "dns=unrepaired reason=no-platform-servers host=$host"
    elif [ "$(readlink "$resolv" 2>/dev/null)" = /proc/net/pnp ]; then
      report "dns=unrepaired reason=kernel-list host=$host"
    elif only_platform_servers; then
      # Rewriting cannot help: the platform's own server already fails (an
      # upstream outage or blocked egress), so the file stays as it is.
      report "dns=unrepaired reason=platform-server-fails host=$host"
    else
      if as_root sh -c '
        rm -f "$1.opengeni-new" "$1${OWNED_BOX_REPLACED_RESOLV_CONF_SUFFIX}" || exit 1
        if [ -e "$1" ] || [ -L "$1" ]; then cp -P "$1" "$1${OWNED_BOX_REPLACED_RESOLV_CONF_SUFFIX}" || exit 1; fi
        printf "%s\\n" "$2" > "$1.opengeni-new" && chmod 644 "$1.opengeni-new" && mv -f "$1.opengeni-new" "$1"
      ' sh "$resolv" "$wanted" >/dev/null 2>&1; then
        servers_list=$(printf '%s' "$servers" | tr '\\n' ',')
        if lookup; then
          report "dns=restored servers=$servers_list host=$host"
        else
          report "dns=restored-still-failing servers=$servers_list host=$host"
        fi
      else
        report "dns=unrepaired reason=write-failed host=$host"
      fi
    fi
  fi
fi
exit 0
`;
}

export type OwnedBoxRepairReport = {
  clock?: { set: boolean; fromEpochSeconds: number; toEpochSeconds: number };
  dns?: {
    outcome: "restored" | "restored-still-failing" | "unrepaired";
    reason?: string;
    servers?: string[];
    host?: string;
  };
};

function fields(line: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of line.split(/\s+/u)) {
    const separator = part.indexOf("=");
    if (separator > 0) result[part.slice(0, separator)] = part.slice(separator + 1);
  }
  return result;
}

/** What the repair command found and did, from its report lines. */
export function parseOwnedBoxRepairOutput(output: string): OwnedBoxRepairReport {
  const report: OwnedBoxRepairReport = {};
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith(REPORT_PREFIX)) continue;
    const values = fields(line.slice(REPORT_PREFIX.length));
    if (values.clock === "set" || values.clock === "unset") {
      const from = Number(values.from);
      const to = Number(values.to);
      if (Number.isFinite(from) && Number.isFinite(to)) {
        report.clock = { set: values.clock === "set", fromEpochSeconds: from, toEpochSeconds: to };
      }
    }
    if (
      values.dns === "restored" ||
      values.dns === "restored-still-failing" ||
      values.dns === "unrepaired"
    ) {
      report.dns = {
        outcome: values.dns,
        ...(values.reason ? { reason: values.reason } : {}),
        ...(values.servers ? { servers: values.servers.split(",").filter(Boolean) } : {}),
        ...(values.host ? { host: values.host } : {}),
      };
    }
  }
  return report;
}

function utc(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  return Number.isFinite(date.getTime())
    ? `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`
    : "an invalid time";
}

const UNREPAIRED_DNS_REASONS: Record<string, string> = {
  "no-platform-servers": "no platform name servers are known",
  "kernel-list": "it is the kernel's own list",
  "platform-server-fails":
    "it already lists only the platform name server, so the network itself is failing",
  "write-failed": "it could not be written",
};

/**
 * A short note for the model when setup found the box's clock or resolver
 * broken, so it knows what changed or what will still fail. Null when the
 * box was healthy.
 */
export function ownedBoxRepairNote(report: OwnedBoxRepairReport): string | null {
  const lines: string[] = [];
  if (report.clock?.set) {
    lines.push(
      `- Its clock said ${utc(report.clock.fromEpochSeconds)}, so Opengeni set it to ${utc(report.clock.toEpochSeconds)}.`,
    );
  } else if (report.clock) {
    lines.push(
      `- Its clock says ${utc(report.clock.fromEpochSeconds)}, but the time is ${utc(report.clock.toEpochSeconds)}, and Opengeni could not set it; TLS and git may fail until it is fixed.`,
    );
  }
  if (report.dns?.outcome === "restored" || report.dns?.outcome === "restored-still-failing") {
    const servers = report.dns.servers?.join(", ") || "the platform name servers";
    lines.push(
      `- It could not look up ${report.dns.host ?? "Opengeni"}, so Opengeni restored /etc/resolv.conf to the platform name servers (${servers}); the previous file is /etc/resolv.conf${OWNED_BOX_REPLACED_RESOLV_CONF_SUFFIX}.${
        report.dns.outcome === "restored-still-failing" ? " Lookups still fail." : ""
      }`,
    );
  } else if (report.dns) {
    const reason = UNREPAIRED_DNS_REASONS[report.dns.reason ?? ""];
    lines.push(
      `- It cannot look up ${report.dns.host ?? "Opengeni"}, and Opengeni left /etc/resolv.conf unchanged${reason ? ` because ${reason}` : ""}.`,
    );
  }
  if (lines.length === 0) return null;
  return ["[Opengeni checked this chat's workspace machine before this turn]", ...lines].join("\n");
}

import type { ChannelAExecArgs } from "../channel-a";

/** Keep the command payload once in argv. Embedding it in each run-as branch
 * multiplies large lifecycle scripts past the provider's aggregate limit. */
export function modalCommandArgv(args: ChannelAExecArgs): string[] {
  const command = [
    args.shell ?? "/bin/sh",
    args.shell && (args.login ?? true) ? "-lc" : "-c",
    args.cmd,
  ];
  if (!args.runAs) return command;
  return [
    "/bin/sh",
    "-c",
    'user=$1; shift; if [ "$(id -u)" = "$user" ] || [ "$(id -un 2>/dev/null)" = "$user" ]; then exec "$@"; elif [ "$(id -u)" = 0 ]; then exec su -s /bin/sh -c \'exec "$@"\' -- "$user" sh "$@"; else exec sudo -n -u "$user" -- "$@"; fi',
    "opengeni-run-as",
    args.runAs,
    ...command,
  ];
}

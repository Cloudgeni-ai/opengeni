import type { ChildProcess } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import {
  elapsedSeconds,
  formatExecResponse,
  truncateOutput,
} from "@openai/agents-core/sandbox/internal";
import type { ProviderCommandSession } from "./provider-command-session";
import { nativeSynchronousCollectionCovers } from "./native-synchronous-collection";

/**
 * Session-owned processes for the Docker and Unix-local sandbox backends.
 *
 * The Agents SDK keeps a yielded command as a child of the worker process and
 * addresses it by a small number in an in-memory table on one session object.
 * That handle dies with the object, so such a command could only ever belong
 * to the turn that started it. Here every command instead runs under a tiny
 * POSIX `sh` supervisor inside the sandbox itself: its stdin is a FIFO, its
 * output goes to a file with a committed read offset, and its exit status is
 * written next to them. Any later session object for the same container or
 * workspace (a later turn, another worker, the server reaper) can therefore
 * read, write and stop it with one short shell invocation per operation.
 *
 * Handles are random numbers at or above {@link DURABLE_PROCESS_ID_MIN}, so they
 * never collide with the SDK's own small in-memory ids, which stay in use for
 * commands this supervisor cannot host (a `runAs` user, a terminal without
 * util-linux `script`, or a sandbox without `mkfifo` and fractional `sleep`).
 */

export const DURABLE_PROCESS_ID_MIN = 1_000_000;
// Provider session ids are stored in a 32-bit integer column.
const DURABLE_PROCESS_ID_MAX = 2_147_483_647;
const MAX_READ_BYTES = 1024 * 1024;
const DEFAULT_EXEC_YIELD_MS = 10_000;
const DEFAULT_WRITE_YIELD_MS = 250;
const ONE_SHOT_GRACE_MS = 30_000;
/** A supervised stop sends TERM to the command's process group, then KILL
 * this many seconds later, so a stopped command is gone within that bound. */
export const SUPERVISED_STOP_KILL_AFTER_SECONDS = 5;
const LAUNCH_ATTEMPTS = 5;

export type DurableShellBackend = "docker" | "local";

type SpawnArgs = {
  cwd: string;
  logicalCwd: string;
  shell?: string | undefined;
  login: boolean;
  runAs?: string | undefined;
  tty: boolean;
};

type ExecArgs = {
  cmd: string;
  workdir?: string;
  shell?: string;
  login?: boolean;
  tty?: boolean;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
  runAs?: string;
};

type WriteArgs = {
  sessionId: number;
  chars?: string;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
};

/** The protected Unix-local/Docker SDK session surface this module drives. */
type SdkUnixSession = {
  state: { workspaceRootPath: string };
  defaultShell?: string | undefined;
  activeProcesses?: Map<number, unknown>;
  execCommand(args: ExecArgs): Promise<string>;
  writeStdin(args: WriteArgs): Promise<string>;
  close?(): Promise<void>;
  spawnShellCommand(command: string, args: SpawnArgs): Promise<ChildProcess>;
  resolveCommandWorkdir(path?: string): string;
  logicalWorkdirForPath(path?: string): string;
  translateCommandInput(command: string): string;
  translateCommandOutput(output: string): string;
};

/** Methods added to an installed session. */
export type DurableShellProcessSession = {
  /** True for a handle this supervisor hosts: it survives the session object. */
  isDurableProcessHandle(providerSessionId: number): boolean;
  /** Stop the command's process group: TERM now, KILL after five seconds.
   * Returns false when no such supervised command exists. The exit is
   * reported by the next read, like any other exit. */
  stopDurableProcess(providerSessionId: number): Promise<boolean>;
};

const INSTALLED = Symbol.for("opengeni.durable-shell-process");

export function isDurableProcessId(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= DURABLE_PROCESS_ID_MIN &&
    value <= DURABLE_PROCESS_ID_MAX
  );
}

export function hasDurableShellProcesses(session: unknown): session is DurableShellProcessSession {
  return (
    typeof session === "object" &&
    session !== null &&
    (session as Record<symbol, unknown>)[INSTALLED] === true
  );
}

/** Whether a process handle runs under the in-sandbox supervisor, so any
 * worker with that supervisor (but no older one) can reach it. */
export function isInSandboxSupervisedProcess(session: unknown, providerSessionId: number): boolean {
  return hasDurableShellProcesses(session) && session.isDurableProcessHandle(providerSessionId);
}

/** The SDK's exact loss banner: the reaper and the turn both treat it as
 * proof that this handle can never report again. */
export function durableProcessLostResult(id: number): string {
  return formatExecResponse({
    output: `write_stdin failed: session not found: ${id}`,
    wallTimeSeconds: 0,
    exitCode: 1,
  });
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value.trim().length > 0);
}

/** Mirror the SDK's shell selection exactly, so a supervised command runs
 * under the same shell and login semantics as an SDK-spawned one. */
function resolveShell(
  backend: DurableShellBackend,
  session: SdkUnixSession,
  args: ExecArgs,
): { shellPath: string; flag: string } {
  const login = args.login ?? true;
  const configured =
    backend === "local"
      ? firstNonEmpty(args.shell, session.defaultShell, process.env.SHELL)
      : firstNonEmpty(args.shell, session.defaultShell);
  if (configured) return { shellPath: configured, flag: login ? "-lc" : "-c" };
  return { shellPath: "/bin/sh", flag: "-c" };
}

function namespaceFor(backend: DurableShellBackend, session: SdkUnixSession): string {
  // One container is one namespace. Unix-local workspaces share the worker
  // host, so each workspace path gets its own directory.
  if (backend === "docker") return "c";
  return createHash("sha256").update(session.state.workspaceRootPath).digest("hex").slice(0, 16);
}

/** Shared POSIX sh functions. `d` is the run directory, `r` its parent.
 * Parameter expansions are written `@{...}` so the template stays raw. */
const PRELUDE = String.raw`
og_ident() {
  if [ -r "/proc/$1/stat" ]; then
    IFS= read -r og_stat < "/proc/$1/stat" || return 0
    og_stat="@{og_stat##*) }"
    set -- $og_stat
    [ "$1" = Z ] && return 0
    shift 19
    printf '%s' "$1"
  else
    case "$(ps -o stat= -p "$1" 2>/dev/null)" in Z*|"") return 0 ;; esac
    ps -o lstart= -p "$1" 2>/dev/null | tr -s ' '
  fi
}
og_alive() {
  [ -f "$d/wrapper" ] || return 1
  og_w=$(cat "$d/wrapper")
  og_p=@{og_w%% *}
  og_want=@{og_w#* }
  kill -0 "$og_p" 2>/dev/null || return 1
  og_now=$(og_ident "$og_p")
  [ -n "$og_now" ] && [ "$og_now" = "$og_want" ]
}
og_holds() {
  # A lock names its holder as "pid start-identity"; a reused pid is not it.
  og_hp=@{1%% *}
  kill -0 "$og_hp" 2>/dev/null && [ "$(og_ident "$og_hp")" = "@{1#* }" ]
}
og_take() {
  # A symlink is created atomically together with its holder, so a lock is
  # never seen without one. A dead holder's lock is removed only under a
  # short take-over guard that re-checks it is still that same holder.
  og_n=0
  while ! ln -s "$$ $(og_ident $$)" "$1" 2>/dev/null; do
    og_t=$(readlink "$1" 2>/dev/null)
    if [ -n "$og_t" ] && ! og_holds "$og_t"; then
      if mkdir "$1.steal" 2>/dev/null; then
        [ "$(readlink "$1" 2>/dev/null)" = "$og_t" ] && rm -f "$1"
        rmdir "$1.steal"
        continue
      fi
      [ -n "$(find "$1.steal" -prune -mmin +1 2>/dev/null)" ] && rmdir "$1.steal" 2>/dev/null
    fi
    og_n=$((og_n + 1))
    [ "$og_n" -ge "$2" ] && return 1
    sleep 0.02
  done
  return 0
}
og_lock() {
  og_take "$d/lock" 1000000000
}
og_unlock() {
  rm -f "$d/lock"
}
og_unblock() {
  # A writer can only block on a command that stopped reading; once that
  # command has ended, nothing will ever read the rest of its input.
  og_t=$(readlink "$d/wlock" 2>/dev/null)
  [ -n "$og_t" ] && og_holds "$og_t" && kill "@{og_t%% *}" 2>/dev/null
  return 0
}
og_signal() {
  # Signal the command's process group only while it is provably still that
  # command's: its leader alive with the recorded start identity, or the
  # leader gone while members remain (an id in use as a group is never
  # reused). Without a group of its own, only the live leader itself.
  if kill -0 "$2" 2>/dev/null; then
    [ "$(og_ident "$2")" = "$3" ] || return 0
    kill -"$1" -"$2" 2>/dev/null || kill -"$1" "$2" 2>/dev/null
  else
    kill -"$1" -"$2" 2>/dev/null
  fi
  return 0
}
og_utf8_drop() {
  set -- $(tail -c +$(($1 + 1)) "$d/out" | head -c "$2" | tail -c 3 | od -An -tu1)
  og_k=$#
  og_b1=$1; og_b2=$2; og_b3=$3
  og_j=$og_k
  og_drop=0
  while [ "$og_j" -ge 1 ]; do
    eval "og_b=\$og_b$og_j"
    og_t=$((og_k - og_j + 1))
    [ "$og_b" -lt 128 ] && break
    if [ "$og_b" -ge 192 ]; then
      og_need=2
      [ "$og_b" -ge 224 ] && og_need=3
      [ "$og_b" -ge 240 ] && og_need=4
      [ "$og_need" -gt "$og_t" ] && og_drop=$og_t
      break
    fi
    og_j=$((og_j - 1))
  done
  printf '%s' "$og_drop"
}
og_poll() {
  if [ ! -f "$d/wrapper" ]; then printf '@@OG1 missing 1 0\n'; return 0; fi
  if [ -f "$d/reported" ]; then
    og_st=$(cat "$d/reported")
    og_code=1
    [ "$og_st" = exited ] && og_code=$(cat "$d/exit")
    printf '@@OG1 %s %s 0\n' "$og_st" "$og_code"
    return 0
  fi
  og_i=0
  og_n=$((og_y / 50))
  while [ "$og_i" -lt "$og_n" ] && [ ! -f "$d/exit" ] && og_alive; do
    sleep 0.05
    og_i=$((og_i + 1))
  done
  og_lock
  og_e=
  [ -f "$d/exit" ] && og_e=$(cat "$d/exit")
  og_dead=0
  if [ -z "$og_e" ] && ! og_alive; then
    if [ -f "$d/exit" ]; then og_e=$(cat "$d/exit"); else og_dead=1; fi
  fi
  og_o=$(cat "$d/off")
  og_s=$(wc -c < "$d/out" | tr -d ' ')
  og_c=$((og_s - og_o))
  [ "$og_c" -gt "$og_m" ] && og_c=$og_m
  og_fin=0
  if [ -n "$og_e" ] && [ $((og_o + og_c)) -eq "$og_s" ]; then og_fin=1; fi
  if [ "$og_dead" = 1 ] && [ "$og_c" -eq 0 ]; then og_fin=1; fi
  if [ "$og_c" -gt 0 ] && [ "$og_fin" = 0 ]; then
    og_c=$((og_c - $(og_utf8_drop "$og_o" "$og_c")))
  fi
  og_st=running
  og_code=0
  if [ "$og_fin" = 1 ]; then
    if [ -n "$og_e" ]; then og_st=exited; og_code=$og_e; else og_st=lost; og_code=1; fi
  fi
  printf '@@OG1 %s %s %s\n' "$og_st" "$og_code" "$og_c"
  [ "$og_c" -gt 0 ] && tail -c +$((og_o + 1)) "$d/out" | head -c "$og_c"
  echo $((og_o + og_c)) > "$d/off.tmp" && mv "$d/off.tmp" "$d/off"
  if [ "$og_fin" = 1 ]; then echo "$og_st" > "$d/reported"; og_unblock; fi
  og_unlock
  return 0
}
og_stop() {
  [ -f "$d/child" ] || return 1
  og_c=$(cat "$d/child")
  og_ci=$(cat "$d/child.id" 2>/dev/null)
  # The whole process group, including anything the command left running
  # after its own shell exited. The escalation needs no run directory.
  og_signal TERM "$og_c" "$og_ci"
  (
    sleep ${SUPERVISED_STOP_KILL_AFTER_SECONDS}
    og_signal KILL "$og_c" "$og_ci"
  ) </dev/null >/dev/null 2>&1 &
  return 0
}
og_launch() {
  # An asynchronous command in a shell without job control starts with
  # SIGINT and SIGQUIT ignored, and a shell cannot undo that for itself.
  # Restore them so Ctrl-C reaches the command as it would in a terminal;
  # a box with none of these tools keeps them ignored.
  if env --default-signal=INT,QUIT true 2>/dev/null; then
    set -- env --default-signal=INT,QUIT "$@"
  elif command -v perl >/dev/null 2>&1; then
    set -- perl -e '$SIG{INT} = $SIG{QUIT} = "DEFAULT"; exec { $ARGV[0] } @ARGV or exit 127' "$@"
  elif command -v python3 >/dev/null 2>&1; then
    og_launch_python "$@"
  fi
  if command -v setsid >/dev/null 2>&1; then exec setsid "$@"; fi
  if command -v python3 >/dev/null 2>&1; then og_launch_python "$@"; fi
  exec "$@"
}
og_launch_python() {
  exec python3 -c 'import os,signal,sys; signal.signal(signal.SIGINT, signal.SIG_DFL); signal.signal(signal.SIGQUIT, signal.SIG_DFL); os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' "$@"
}
`.replaceAll("@{", "${");

function rootLines(namespace: string): string[] {
  return [
    "umask 077",
    'og_base="${TMPDIR:-/tmp}/opengeni-exec-$(id -u)"',
    `r="$og_base/${namespace}"`,
  ];
}

function controlScript(namespace: string, id: number, body: string[]): string {
  return [...rootLines(namespace), `d="$r/${id}"`, PRELUDE, ...body].join("\n");
}

const UNSUPPORTED = "{ printf '@@OG1 unsupported 0 0\\n'; exit 0; }";

function launchScript(input: {
  namespace: string;
  id: number;
  shellPath: string;
  flag: string;
  tty: boolean;
  yieldMs: number;
}): string {
  return [
    ...rootLines(input.namespace),
    `d="$r/${input.id}"`,
    PRELUDE,
    // Probe before anything starts: a sandbox without these tools keeps the
    // SDK's in-memory process path for this command.
    `command -v mkfifo >/dev/null 2>&1 || ${UNSUPPORTED}`,
    `sleep 0.01 2>/dev/null || ${UNSUPPORTED}`,
    ...(input.tty ? [`script --version 2>/dev/null | grep -q util-linux || ${UNSUPPORTED}`] : []),
    `mkdir -p "$og_base" 2>/dev/null || ${UNSUPPORTED}`,
    // Never follow a directory another user planted in a shared /tmp.
    `{ [ -O "$og_base" ] && [ ! -L "$og_base" ]; } || ${UNSUPPORTED}`,
    `mkdir -p "$r" || ${UNSUPPORTED}`,
    "mkdir \"$d\" 2>/dev/null || { printf '@@OG1 collision 0 0\\n'; exit 0; }",
    `{ mkfifo "$d/in" && cat > "$d/cmd" && : > "$d/out" && echo 0 > "$d/off"; } || { rm -rf "$d"; printf '@@OG1 unsupported 0 0\\n'; exit 0; }`,
    ...(input.tty ? [': > "$d/tty"'] : []),
    // Settled runs are kept a day so every reader sees the same exit.
    'find "$r" -mindepth 2 -maxdepth 2 -name reported -mmin +1440 2>/dev/null | while IFS= read -r og_f; do rm -rf "${og_f%/reported}"; done',
    `og_sp=${quote(input.shellPath)}`,
    `og_fl=${quote(input.flag)}`,
    "(",
    '  exec 3<>"$d/in"',
    input.tty
      ? '  SHELL="$og_sp"; export SHELL; og_launch script -qfec "$(cat "$d/cmd")" /dev/null <&3 3<&- >>"$d/out" 2>&1 &'
      : '  og_launch "$og_sp" "$og_fl" "$(cat "$d/cmd")" <&3 3<&- >>"$d/out" 2>&1 &',
    "  og_child=$!",
    '  og_ident "$og_child" > "$d/child.id"',
    '  echo "$og_child" > "$d/child.tmp" && mv "$d/child.tmp" "$d/child"',
    '  wait "$og_child"',
    "  og_status=$?",
    '  echo "$og_status" > "$d/exit.tmp" && mv "$d/exit.tmp" "$d/exit"',
    ") </dev/null >/dev/null 2>&1 &",
    "og_wrapper=$!",
    'printf \'%s %s\\n\' "$og_wrapper" "$(og_ident "$og_wrapper")" > "$d/wrapper.tmp" && mv "$d/wrapper.tmp" "$d/wrapper"',
    `og_y=${Math.max(0, Math.floor(input.yieldMs))}`,
    `og_m=${MAX_READ_BYTES}`,
    "og_poll",
  ].join("\n");
}

function writeScript(input: {
  namespace: string;
  id: number;
  hasInput: boolean;
  interrupt: boolean;
  yieldMs: number;
}): string {
  return controlScript(input.namespace, input.id, [
    'if [ -f "$d/wrapper" ] && [ ! -f "$d/reported" ]; then',
    "  :",
    ...(input.interrupt
      ? [
          // Through a terminal, Ctrl-C is an ordinary byte the terminal turns
          // into a signal. Without one it is a signal to the command's process
          // group, exactly as in the SDK, and never stdin data. It needs no
          // pipe space, so it works even while earlier input is still waiting.
          '  if [ ! -f "$d/tty" ] && [ -f "$d/child" ] && [ ! -f "$d/exit" ]; then',
          '    og_signal INT "$(cat "$d/child")" "$(cat "$d/child.id" 2>/dev/null)"',
          "  fi",
        ]
      : []),
    ...(input.hasInput
      ? [
          '  og_ib="$d/inbuf.$$"',
          '  cat > "$og_ib"',
          '  if [ ! -f "$d/tty" ]; then tr -d \'\\003\' < "$og_ib" > "$og_ib.t" && mv "$og_ib.t" "$og_ib"; fi',
          '  if [ -s "$og_ib" ]; then',
          // One writer at a time keeps inputs in order. A command that has
          // stopped reading fills the pipe; its writer then waits in the
          // background and this call still returns, never blocking the turn.
          // The lock passes to the copying process itself, so it is free
          // exactly when that process is gone.
          '    og_take "$d/wlock" 250 || { rm -f "$og_ib"; printf \'@@OG1 busy 0 0\\n\'; exit 0; }',
          // Input can carry secrets (write_stdin values, streamed secret
          // files). The writer reads it from an open descriptor and the file
          // is unlinked at once, so no input stays on disk after this call.
          '    exec 4< "$og_ib"',
          '    rm -f "$og_ib"',
          '    cat <&4 1<>"$d/in" 4<&- 2>/dev/null &',
          "    og_wp=$!",
          "    exec 4<&-",
          '    ln -s "$og_wp $(og_ident "$og_wp")" "$d/wlock.n" && mv -f "$d/wlock.n" "$d/wlock"',
          "    og_i=0",
          // An exited, not yet reaped writer has no identity: it is done.
          '    while [ "$og_i" -lt 20 ] && [ -n "$(og_ident "$og_wp")" ]; do sleep 0.05; og_i=$((og_i + 1)); done',
          "  else",
          '    rm -f "$og_ib"',
          "  fi",
        ]
      : []),
    "fi",
    `og_y=${Math.max(0, Math.floor(input.yieldMs))}`,
    `og_m=${MAX_READ_BYTES}`,
    "og_poll",
  ]);
}

function stopAllScript(namespace: string): string {
  return [
    ...rootLines(namespace),
    PRELUDE,
    '[ -d "$r" ] || exit 0',
    'for d in "$r"/*; do [ -d "$d" ] && og_stop; done',
    "og_i=0",
    'while [ "$og_i" -lt 40 ]; do',
    "  og_left=0",
    '  for d in "$r"/*; do if [ -f "$d/child" ] && [ ! -f "$d/exit" ] && og_alive; then og_left=1; fi; done',
    '  [ "$og_left" = 0 ] && break',
    "  sleep 0.05",
    "  og_i=$((og_i + 1))",
    "done",
    'for d in "$r"/*; do',
    '  if [ -f "$d/child" ]; then',
    '    og_signal KILL "$(cat "$d/child")" "$(cat "$d/child.id" 2>/dev/null)"',
    "  fi",
    "  og_unblock",
    "done",
    'rm -rf "$r"',
  ].join("\n");
}

type PollStatus = "running" | "exited" | "lost" | "missing" | "unsupported" | "collision" | "busy";

type PollResult = { status: PollStatus; code: number; output: string };

function parsePoll(stdout: Buffer): PollResult | null {
  const newline = stdout.indexOf(10);
  if (newline < 0) return null;
  const header = stdout.subarray(0, newline).toString("utf8");
  const match =
    /^@@OG1 (running|exited|lost|missing|unsupported|collision|busy) (-?\d+) (\d+)$/.exec(header);
  if (!match) return null;
  const length = Number(match[3]);
  const body = stdout.subarray(newline + 1, newline + 1 + length);
  if (body.length !== length) return null;
  return {
    status: match[1] as PollStatus,
    code: Number(match[2]),
    output: body.toString("utf8"),
  };
}

async function runOneShot(child: ChildProcess, stdin: string, timeoutMs: number): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Sandbox process supervisor did not answer in time"));
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out);
      if (code !== 0 && stdout.indexOf(10) < 0) {
        const detail = Buffer.concat(err).toString("utf8").trim().slice(0, 500);
        reject(
          new Error(
            `Sandbox process supervisor exited with code ${code}${detail ? `: ${detail}` : ""}`,
          ),
        );
        return;
      }
      resolve(stdout);
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(stdin);
  });
}

/**
 * Make every ordinary command on this Docker or Unix-local SDK session
 * session-owned. Idempotent. The SDK's own methods remain the fallback for
 * commands the supervisor cannot host and for its small in-memory handles.
 */
export function installDurableShellProcesses<T extends object>(
  session: T,
  backend: DurableShellBackend,
): T & DurableShellProcessSession {
  const target = session as unknown as SdkUnixSession & Record<symbol, unknown>;
  if (target[INSTALLED] === true) return session as T & DurableShellProcessSession;
  const sdkExec = target.execCommand.bind(target);
  const sdkWrite = target.writeStdin.bind(target);
  const sdkClose = target.close?.bind(target);
  let unsupported = false;
  let ttyUnsupported = false;
  const namespace = () => namespaceFor(backend, target);
  const runControl = async (script: string, stdin: string, timeoutMs: number): Promise<Buffer> =>
    await runOneShot(
      await target.spawnShellCommand(script, {
        cwd: target.resolveCommandWorkdir(undefined),
        logicalCwd: target.logicalWorkdirForPath(undefined),
        shell: "/bin/sh",
        login: false,
        tty: false,
      }),
      stdin,
      timeoutMs,
    );
  const render = (
    id: number,
    result: PollResult,
    start: number,
    maxOutputTokens: number | undefined,
  ): string => {
    if (result.status === "lost" || result.status === "missing")
      return durableProcessLostResult(id);
    if (result.status === "busy") {
      return formatExecResponse({
        output: `write_stdin failed: process ${id} has not read its earlier input yet, so this input was not sent. Read its output with empty input, then try again.`,
        wallTimeSeconds: elapsedSeconds(start),
        sessionId: id,
      });
    }
    const output = truncateOutput(target.translateCommandOutput(result.output), maxOutputTokens);
    return formatExecResponse({
      output: output.text,
      wallTimeSeconds: elapsedSeconds(start),
      ...(result.status === "exited" ? { exitCode: result.code } : { sessionId: id }),
      ...(output.originalTokenCount !== undefined
        ? { originalTokenCount: output.originalTokenCount }
        : {}),
    });
  };
  const isHandle = (id: number): boolean =>
    isDurableProcessId(id) && target.activeProcesses?.has(id) !== true;

  target.execCommand = async (args: ExecArgs): Promise<string> => {
    const tty = args.tty === true;
    // A worker synchronous runner (file reads, git helpers, captures) observes
    // the SDK's own child and its separate streams; it never outlives its call.
    if (
      args.runAs !== undefined ||
      unsupported ||
      (tty && ttyUnsupported) ||
      nativeSynchronousCollectionCovers(target)
    ) {
      return await sdkExec(args);
    }
    const start = Date.now();
    const { shellPath, flag } = resolveShell(backend, target, args);
    const yieldMs = args.yieldTimeMs ?? DEFAULT_EXEC_YIELD_MS;
    const cwd = target.resolveCommandWorkdir(args.workdir);
    const logicalCwd = target.logicalWorkdirForPath(args.workdir);
    for (let attempt = 0; attempt < LAUNCH_ATTEMPTS; attempt += 1) {
      const id = randomInt(DURABLE_PROCESS_ID_MIN, DURABLE_PROCESS_ID_MAX);
      if (target.activeProcesses?.has(id)) continue;
      // The launcher itself runs under plain sh; the command runs under the
      // shell the SDK would have used, in the requested working directory.
      // Launch and the first wait share one invocation.
      const child = await target.spawnShellCommand(
        launchScript({ namespace: namespace(), id, shellPath, flag, tty, yieldMs }),
        { cwd, logicalCwd, shell: "/bin/sh", login: false, tty: false },
      );
      const result = parsePoll(
        await runOneShot(
          child,
          target.translateCommandInput(args.cmd),
          yieldMs + ONE_SHOT_GRACE_MS,
        ),
      );
      if (!result) throw new Error("Sandbox process supervisor returned no status");
      if (result.status === "collision") continue;
      if (result.status === "unsupported") {
        if (tty) ttyUnsupported = true;
        else unsupported = true;
        return await sdkExec(args);
      }
      if (result.status === "missing") {
        throw new Error("Sandbox process supervisor lost its run directory during launch");
      }
      return render(id, result, start, args.maxOutputTokens);
    }
    throw new Error("Sandbox process supervisor could not allocate a process handle");
  };

  target.writeStdin = async (args: WriteArgs): Promise<string> => {
    if (!isHandle(args.sessionId)) return await sdkWrite(args);
    const start = Date.now();
    const chars = args.chars ?? "";
    const yieldMs = args.yieldTimeMs ?? DEFAULT_WRITE_YIELD_MS;
    const result = parsePoll(
      await runControl(
        writeScript({
          namespace: namespace(),
          id: args.sessionId,
          hasInput: chars.length > 0,
          interrupt: chars.includes("\u0003"),
          yieldMs,
        }),
        chars,
        yieldMs + ONE_SHOT_GRACE_MS,
      ),
    );
    if (!result) throw new Error("Sandbox process supervisor returned no status");
    return render(args.sessionId, result, start, args.maxOutputTokens);
  };

  const extension: DurableShellProcessSession = {
    isDurableProcessHandle: isHandle,
    stopDurableProcess: async (id: number): Promise<boolean> => {
      if (!isHandle(id)) return false;
      const stdout = await runControl(
        controlScript(namespace(), id, ["if og_stop; then printf yes; else printf no; fi"]),
        "",
        ONE_SHOT_GRACE_MS,
      );
      return stdout.toString("utf8") === "yes";
    },
  };
  Object.assign(target, extension);
  // The reaper and turn finalization stop a supervised command through this
  // provider-neutral hook; the supervisor signals the exact process group.
  const priorCancel = (target as ProviderCommandSession).cancelSupervisedCommand?.bind(target);
  (target as ProviderCommandSession).cancelSupervisedCommand = async (handle, reason) => {
    if (isHandle(handle)) return await extension.stopDurableProcess(handle);
    return (await priorCancel?.(handle, reason)) ?? false;
  };

  if (backend === "local" && sdkClose) {
    // A local workspace's commands run on the worker host. Closing the
    // workspace (lease termination) stops every command it still supervises;
    // a container's commands end with the container instead.
    target.close = async (): Promise<void> => {
      try {
        await runControl(stopAllScript(namespace()), "", ONE_SHOT_GRACE_MS);
      } catch {
        // A missing workspace has nothing left to stop; close still runs.
      }
      await sdkClose();
    };
  }
  target[INSTALLED] = true;
  return session as T & DurableShellProcessSession;
}

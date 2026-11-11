// Modal has no in-box agent: every Opengeni command is a Modal exec of
// `/bin/sh -c <command>` (modal-command-argv.ts). Once the box's /bin/sh is
// gone or unusable, Modal answers every exec, as a result with exit code 128,
// with
//   executing processes for container: executing command "<the whole
//   command>" in sandbox: failed to load /bin/sh: no such file or directory
// (observed on staging, 4 Nov 2026). No command can run on that box again, so
// it is a machine that cannot start programs, not one missing program. The
// text repeats the whole command, so only its stable tail is ever kept.

/**
 * `" in sandbox: failed to load /bin/sh: <cause>` after the closing quote of
 * the command Modal repeats. Inside that command a quote is escaped (`\"`), so
 * a quote after an even number of backslashes marks Modal's own tail; the last such match is used, so
 * command text that contains the same words is never taken for the cause.
 */
const MODAL_SHELL_LOAD_FAILURE =
  /(?<=(?:^|[^\\])(?:\\\\)*)" in sandbox: failed to load \/bin\/sh(?::[ \t]*([^\n"\\]{0,200}))?/g;

/** This module's own sanitized form, so a wrapped copy is still recognised. */
const SANITIZED_SHELL_LOAD_FAILURE =
  /\bModal could not start the sandbox shell: failed to load \/bin\/sh\b/;

function lastShellLoadFailure(message: string): RegExpExecArray | null {
  let last: RegExpExecArray | null = null;
  for (const match of message.matchAll(MODAL_SHELL_LOAD_FAILURE)) last = match as RegExpExecArray;
  return last;
}

/** Whether `message` is Modal's answer for an exec whose shell cannot load. */
export function isModalShellStartFailureMessage(message: string): boolean {
  return lastShellLoadFailure(message) !== null || SANITIZED_SHELL_LOAD_FAILURE.test(message);
}

/**
 * Modal's shell-load failure without the command it repeats; any other
 * message is returned unchanged.
 */
export function sanitizeModalShellStartFailureMessage(message: string): string {
  const match = lastShellLoadFailure(message);
  if (!match) return message;
  const cause = match[1]?.trim();
  return `Modal could not start the sandbox shell: failed to load /bin/sh${cause ? `: ${cause}` : ""}`;
}

/** Modal's own exec error, as the whole output of a command it could not start. */
const MODAL_EXEC_ERROR_OUTPUT = /^\s*executing processes for container: /;

/**
 * What the model sees instead of Modal's exec error when a command could not
 * start because /bin/sh does not load: the error repeats the whole wrapper
 * script and says nothing about what happens next. Null for any other output,
 * including a command that merely printed the same words after other output.
 */
export function modalShellStartFailureNotice(
  output: string,
  exitCode: number | null,
): string | null {
  // Modal reports a start failure as exit code 128, and its error is the whole
  // output: it begins with Modal's prefix and ends with the shell-load tail.
  const tail = lastShellLoadFailure(output);
  if (
    exitCode !== 128 ||
    !MODAL_EXEC_ERROR_OUTPUT.test(output) ||
    !tail ||
    output.slice(tail.index + tail[0].length).trim() !== ""
  ) {
    return null;
  }
  return [
    `${sanitizeModalShellStartFailureMessage(output)}.`,
    "This command did not run. Every command in this sandbox starts through /bin/sh, so no command can run here until the sandbox is replaced.",
    "When the sandbox is next set up, it is replaced with a fresh one restored from /workspace; changes outside /workspace are lost.",
  ].join("\n");
}

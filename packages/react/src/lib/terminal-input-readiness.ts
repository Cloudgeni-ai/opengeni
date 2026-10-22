/** Negotiated by the stock ttyd launcher, never inferred from ordinary output.
 * The Bash Readline adapter emits this OSC only at its first input boundary.
 * It is metadata (ignored by older xterm clients), not a prompt string. */
export const TERMINAL_INPUT_READY_PREFERENCE = "opengeniInputReady";
export const TERMINAL_INPUT_READY_PROTOCOL = "bash-readline-v1";
const PREFIX = "\x1b]777;opengeni-input;";
const FRAME = /^\x1b\]777;opengeni-input;(hello|ready);([a-f0-9]{32})\x07$/;
const MAX_FRAME = PREFIX.length + "hello;".length + 32 + 1;

/** One decoder per WebSocket/PTY generation. Retains at most a partial marker,
 * rather than buffering terminal output while the shell initializes. */
export function terminalInputReadyDecoder() {
  let pending = "";
  let received = false;
  let identity: string | null = null;
  return (data: string): { output: string; ready: boolean } => {
    let input = pending + data;
    let output = "";
    let ready = false;
    pending = "";
    while (input.length > 0) {
      const marker = input.indexOf(PREFIX);
      if (marker < 0) break;
      output += input.slice(0, marker);
      input = input.slice(marker);
      const end = input.indexOf("\x07", PREFIX.length);
      if (end < 0 && input.length < MAX_FRAME) {
        pending = input;
        return { output, ready };
      }
      const match = end >= 0 && end < MAX_FRAME ? FRAME.exec(input.slice(0, end + 1)) : null;
      if (!match) {
        // Malformed/overlong metadata is ordinary output, never an unbounded
        // parser buffer or permission to deliver input.
        output += input[0];
        input = input.slice(1);
        continue;
      }
      input = input.slice(end + 1);
      if (match[1] === "hello" && identity === null) identity = match[2]!;
      if (match[1] === "ready" && match[2] === identity && !received) {
        ready = true;
        received = true;
      }
    }
    let suffix = Math.min(input.length, PREFIX.length - 1);
    while (suffix > 0 && !PREFIX.startsWith(input.slice(-suffix))) suffix--;
    pending = suffix > 0 ? input.slice(-suffix) : "";
    return { output: output + (suffix > 0 ? input.slice(0, -suffix) : input), ready };
  };
}

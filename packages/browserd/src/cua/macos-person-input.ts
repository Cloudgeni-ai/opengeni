/**
 * How long ago a person last used this Mac's keyboard, mouse or trackpad.
 *
 * `HIDIdleTime` and the HID system state's any-event timer cannot tell: an
 * event posted to a process (`CGEventPostToPid`), as CUA's background keys
 * are, resets both. The HID system state also keeps a timer per event type,
 * and those move only for events that come in through the HID system (the
 * hardware, or input posted at the HID level, as foreground input is), not
 * for events posted to a process. Reading them takes no screenshot and no
 * permission.
 */

/** The input a person makes: buttons, moves and drags of a mouse or
 * trackpad, keys and modifier keys, scrolling, a tablet, and trackpad
 * gestures. Event types from 32 on have no timer of their own: the HID system
 * state answers them with its any-event timer, which events posted to a
 * process reset, so none of them is asked. */
export const PERSON_EVENT_TYPES: readonly number[] = [
  1, 2, 3, 4, 5, 6, 7, 10, 11, 12, 22, 23, 24, 25, 26, 27, 18, 29, 30, 31,
];

/** A person's input this recent is reported; older input is not. */
export const RECENT_PERSON_INPUT_SECONDS = 60;

/** Seconds since a person last used the keyboard, mouse or trackpad, or null
 * when the system does not say. */
export type PersonInputReader = () => number | null;

/** `kCGEventSourceStateHIDSystemState`. */
const HID_SYSTEM_STATE = 1;

/** Reads CoreGraphics' per-type timers, or null when they cannot be loaded. */
export async function macPersonInput(): Promise<PersonInputReader | null> {
  try {
    const { dlopen, FFIType } = await import("bun:ffi");
    const { symbols } = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", {
      CGEventSourceSecondsSinceLastEventType: {
        args: [FFIType.i32, FFIType.u32],
        returns: FFIType.f64,
      },
    });
    return () =>
      newestReading(
        PERSON_EVENT_TYPES.map((type) =>
          Number(symbols.CGEventSourceSecondsSinceLastEventType(HID_SYSTEM_STATE, type)),
        ),
      );
  } catch {
    return null;
  }
}

/** The most recent of `readings`, skipping any that are not a time. */
export function newestReading(readings: readonly number[]): number | null {
  let newest: number | null = null;
  for (const seconds of readings)
    if (Number.isFinite(seconds) && seconds >= 0 && (newest === null || seconds < newest))
      newest = seconds;
  return newest;
}

/** Whole seconds since a person's input, when it was recent enough to say. */
export function recentPersonInput(seconds: number | null): number | undefined {
  return seconds !== null && seconds < RECENT_PERSON_INPUT_SECONDS
    ? Math.floor(seconds)
    : undefined;
}

/** How long after input sent through here ends its events may still reach
 * the HID timers: input the timers show this soon after it is not told
 * apart from it. */
export const AGENT_INPUT_MARGIN_MS = 500;

/**
 * Input agents send through this process that reaches the HID timers the way
 * a person's does: input sent in the foreground or to the whole desktop
 * rather than to one app in the background. Every computer session of the
 * process shares one, so one agent's input never reads as a person to
 * another.
 */
export class AgentInput {
  private sending = 0;
  private endedAt: number | null = null;

  constructor(private readonly now: () => number = () => performance.now()) {}

  /** Runs `send`, input that may reach the HID timers, and notes when it
   * ended, whether it succeeded or not. */
  async around<T>(send: () => Promise<T>): Promise<T> {
    this.sending += 1;
    try {
      return await send();
    } finally {
      this.sending -= 1;
      this.endedAt = this.now();
    }
  }

  /** `seconds` since the last input the HID timers saw, when that input came
   * clearly after any sent through here; null otherwise. */
  personOnly(seconds: number | null): number | null {
    if (seconds === null || this.sending > 0) return null;
    if (this.endedAt === null) return seconds;
    return this.now() - seconds * 1000 > this.endedAt + AGENT_INPUT_MARGIN_MS ? seconds : null;
  }
}

/** The input of this process's computer sessions. */
export const agentInput = new AgentInput();

/** Whether a native CUA call may send input the HID timers see, as a
 * person's: any part of it asks for the foreground (`delivery_mode`
 * "foreground", `foreground_fallback`) or the whole desktop (`scope`
 * "desktop"), or it is a script, which can do either. */
export function reachesHidTimers(tool: string, args: unknown): boolean {
  if (tool === "run_script") return true;
  const asks = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(asks);
    if (!value || typeof value !== "object") return false;
    const record = value as Record<string, unknown>;
    return (
      (typeof record.delivery_mode === "string" &&
        record.delivery_mode.toLowerCase() === "foreground") ||
      record.foreground_fallback === true ||
      (typeof record.scope === "string" && record.scope.toLowerCase() === "desktop") ||
      Object.values(record).some(asks)
    );
  };
  return asks(args);
}

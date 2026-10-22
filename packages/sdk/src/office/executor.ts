// Runs an agent's Office.js code in this workbook: the body of an async
// function (context, Excel, console) inside Excel.run.

export type RunResult =
  | { ok: true; value: unknown; logs: string[]; durationMs: number }
  | {
      ok: false;
      error: {
        name: string;
        code: string | null;
        message: string;
        location: string | null;
        statement: string | null;
      };
      logs: string[];
      durationMs: number;
    };

const MAX_LOGS = 200;
const MAX_LOG_CHARS = 2_000;

type AsyncFunctionConstructor = new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as AsyncFunctionConstructor;
// Strict mode turns silent no-ops into errors, e.g. `range.format.fill = "#fff"`
// (fill is an object; Office ignores the assignment in sloppy mode) or an
// undeclared variable leaking onto the pane's window.
const STRICT = '"use strict";\n';

/** Office objects such as `format.fill` have only getters; say what to do instead. */
export function explainOfficeError(message: string): string {
  const chromium = /^Cannot set property (\w+) of .* which has only a getter$/.exec(message);
  if (chromium || /^Attempted to assign to readonly property\.?$/.test(message)) {
    const what = chromium ? `"${chromium[1]}"` : "this property";
    return `Cannot assign to ${what}: it is an Office.js object, not a value. Set one of its properties instead (for example range.format.fill.color).`;
  }
  return message;
}

function formatLogValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** JSON-safe copy: Office proxies serialize their loaded properties via toJSON. */
export function jsonSafe(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return String(value);
  }
}

export async function runOfficeCode(
  code: string,
  excelRun: (batch: (context: unknown) => Promise<unknown>) => Promise<unknown>,
  excel: unknown,
  now: () => number = () => performance.now(),
): Promise<RunResult> {
  const logs: string[] = [];
  const log =
    (level: string) =>
    (...args: unknown[]) => {
      if (logs.length >= MAX_LOGS) return;
      const line = args.map(formatLogValue).join(" ").slice(0, MAX_LOG_CHARS);
      logs.push(level === "log" ? line : `${level}: ${line}`);
    };
  const agentConsole = {
    log: log("log"),
    info: log("log"),
    debug: log("log"),
    warn: log("warn"),
    error: log("error"),
  };
  const started = now();
  try {
    const body = new AsyncFunction("context", "Excel", "console", STRICT + code);
    const value = await excelRun((context) => body(context, excel, agentConsole));
    return { ok: true, value: jsonSafe(value), logs, durationMs: now() - started };
  } catch (caught) {
    const error = caught as {
      name?: unknown;
      code?: unknown;
      message?: unknown;
      debugInfo?: { errorLocation?: unknown; statement?: unknown };
    };
    const text = (value: unknown) => (typeof value === "string" && value ? value : null);
    return {
      ok: false,
      error: {
        name: text(error?.name) ?? "Error",
        code: text(error?.code),
        message: explainOfficeError(text(error?.message) ?? String(caught)),
        location: text(error?.debugInfo?.errorLocation),
        statement: text(error?.debugInfo?.statement),
      },
      logs,
      durationMs: now() - started,
    };
  }
}

/** Runs one batch at a time, in arrival order, so agent edits never interleave. */
export function serialQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const next = tail.then(task, task);
    tail = next.catch(() => undefined);
    return next;
  };
}

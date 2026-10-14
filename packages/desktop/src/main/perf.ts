import { writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Startup timing marks, in milliseconds since the process started. With
 * OPENGENI_DESKTOP_PERF set to a directory, they are written there as JSON so
 * the budget check can read them.
 */
const marks: Record<string, number> = {};

export function mark(name: string): void {
  if (name in marks) return;
  // process.uptime() counts from process creation, before any JavaScript ran.
  marks[name] = Math.round(process.uptime() * 1000);
}

export function flushMarks(extra: Record<string, number> = {}): void {
  const directory = process.env.OPENGENI_DESKTOP_PERF;
  if (!directory) return;
  try {
    writeFileSync(
      join(directory, `startup-${process.pid}.json`),
      `${JSON.stringify({ ...marks, ...extra }, null, 2)}\n`,
    );
  } catch {
    // Measuring is best effort.
  }
}

import { describe, expect, test } from "bun:test";

const schedulesSource = await Bun.file(`${import.meta.dir}/routes/schedules.tsx`).text();

describe("schedules refresh surface", () => {
  test("reconciles external changes automatically without restoring a refresh button", () => {
    expect(schedulesSource).toContain("const SCHEDULES_POLL_MS = 30_000;");
    expect(schedulesSource).toContain("window.setInterval(reconcileForeground, SCHEDULES_POLL_MS)");
    expect(schedulesSource).toContain('window.addEventListener("focus", reconcileForeground)');
    expect(schedulesSource).toContain(
      'document.addEventListener("visibilitychange", reconcileForeground)',
    );
    expect(schedulesSource).toContain("void refresh(true)");
    expect(schedulesSource).not.toContain(">\n              Refresh\n            </Button>");
  });
});

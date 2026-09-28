import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { toast } from "sonner";
import { notifyDeploymentUpdate } from "./deployment-update";

describe("deployment update notice", () => {
  const notices = spyOn(toast, "info");
  afterEach(() => notices.mockClear());
  afterAll(() => notices.mockRestore());

  test("matching or unknown revisions leave the current task alone", () => {
    notifyDeploymentUpdate("same", "same");
    notifyDeploymentUpdate(undefined, "current");
    notifyDeploymentUpdate("", "current");
    notifyDeploymentUpdate("next", "");
    expect(notices).not.toHaveBeenCalled();
  });

  test("rolling releases offer one dismissible explicit reload, without navigating", () => {
    // There is deliberately no window in this test. A background navigation,
    // including a timer scheduled by the notifier, must not run.
    notifyDeploymentUpdate("next", "current");
    notifyDeploymentUpdate("next", "current");
    notifyDeploymentUpdate("newer", "current");
    expect(notices).toHaveBeenCalledTimes(3);
    const options = notices.mock.calls.map((call) => call[1]);
    expect(new Set(options.map((option) => option?.id)).size).toBe(1);
    expect(options[0]).toMatchObject({
      duration: Infinity,
      closeButton: true,
      action: { label: "Reload", onClick: expect.any(Function) },
    });
  });
});

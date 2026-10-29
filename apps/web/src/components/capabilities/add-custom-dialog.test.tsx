import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());

test("a failed add says why inside the dialog that stays open", async () => {
  const { AddCustomDialog } = await import("./add-custom-dialog");
  const { addConnectionErrorCopy } = await import("./capability-copy");
  const { OpenGeniApiError } = await import("@opengeni/sdk");
  const denied = addConnectionErrorCopy(
    new OpenGeniApiError(
      403,
      JSON.stringify({ error: { message: "missing permission: capabilities:manage" } }),
      { mutation: true },
    ),
  );
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <AddCustomDialog
        open
        onOpenChange={() => {}}
        busy={false}
        onSubmit={() => {}}
        error={denied}
      />,
    ),
  );
  try {
    const alert = document.body.querySelector('[role="dialog"] [role="alert"]');
    expect(alert?.textContent).toContain("You can't add connections here");
    expect(alert?.textContent).toContain("Ask a workspace admin to add this MCP server");
    expect(alert?.textContent).not.toContain("capabilities:manage");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { RigScopeChip } from "./rigs";

beforeAll(() => {
  GlobalRegistrator.register();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

describe("Rigs access scope", () => {
  test("distinguishes personal, workspace, and organization rigs", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      for (const [scope, label] of [
        ["user", "Personal"],
        ["workspace", "Workspace"],
        ["organization", "Organization"],
      ] as const) {
        await act(async () => root.render(<RigScopeChip scope={scope} />));
        expect(container.querySelector(`[data-rig-scope="${scope}"]`)?.textContent).toBe(label);
      }
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

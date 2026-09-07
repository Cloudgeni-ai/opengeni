import { afterEach, expect, test } from "bun:test";
import { actRun, registerDom, renderHook } from "../../../../packages/react/test/render-hook";
import { usePersonalResourceScopeChoice } from "./use-personal-resource-scope-choice";
registerDom();
afterEach(() => document.body.replaceChildren());

test("scope choice defaults to once, is local, and resets across every authority identity", async () => {
  const hook = await renderHook(
    ({ key, visibility }) => usePersonalResourceScopeChoice(key, visibility),
    {
      key: "alice:workspace-a:session-a:resource-a",
      visibility: "workspace" as "workspace" | "private",
    },
  );
  expect(hook.result.current.mode).toBe("once");
  await actRun(() => hook.result.current.setMode("session"));
  expect(hook.result.current.mode).toBe("session");
  for (const key of [
    "bob:workspace-a:session-a:resource-a",
    "bob:workspace-b:session-a:resource-a",
    "bob:workspace-b:session-b:resource-a",
    "bob:workspace-b:session-b:resource-b",
    "bob:workspace-b:session-b:resource-b:credential-generation-2",
    "bob:workspace-b:session-b:resource-b:draft-generation-2",
  ]) {
    await hook.rerender({ key, visibility: "workspace" });
    expect(hook.result.current.mode).toBe("once");
    await actRun(() => hook.result.current.setMode("session"));
  }
  await hook.rerender({ key: "alice:workspace-a:session-a:resource-a", visibility: "workspace" });
  expect(hook.result.current.mode).toBe("once");
  await hook.rerender({ key: "alice:workspace-a:session-a:resource-a", visibility: "private" });
  expect(hook.result.current.mode).toBe("session");
  await hook.rerender({ key: "alice:workspace-a:session-a:resource-a", visibility: "workspace" });
  expect(hook.result.current.mode).toBe("once");
  await hook.unmount();
});

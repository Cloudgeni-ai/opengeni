import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode, useState } from "react";
import { createRoot } from "react-dom/client";

import type { SessionVariableSetPickerSharedState } from "./session-variable-set-picker";

const variableSetId = "11111111-1111-4111-8111-111111111111";
const updateSessionVariableSets = mock(async () => undefined);

mock.module("@opengeni/react", () => ({
  useVariableSets: () => ({
    variableSets: [
      {
        id: variableSetId,
        name: "Deploy credentials",
        scope: "workspace",
        variables: [],
      },
    ],
    loading: false,
    error: null,
    refresh: async () => undefined,
  }),
}));

mock.module("@/context", () => ({
  useAppContext: () => ({ client: { updateSessionVariableSets } }),
}));

mock.module("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

mock.module("sonner", () => ({
  toast: {
    error: mock(() => undefined),
    success: mock(() => undefined),
    warning: mock(() => undefined),
  },
}));

const { SessionVariableSetPicker } = await import("./session-variable-set-picker");

const sessionFixture = {
  id: "22222222-2222-4222-8222-222222222222",
  workspaceId: "33333333-3333-4333-8333-333333333333",
  variableSetIds: [] as string[],
  variableSetId: null,
  tenancy: {
    visibility: "workspace" as const,
    authorityEpoch: 1,
    ownedByCurrentUser: true,
    fork: null,
  },
};

function ResponsivePickerPair(props: { onReloadSession: () => Promise<void> }) {
  const [sharedState, setSharedState] = useState<SessionVariableSetPickerSharedState>({
    saving: false,
    committedSelection: null,
  });
  const picker = (triggerClassName: string) => (
    <SessionVariableSetPicker
      session={sessionFixture}
      canControl
      canAttach
      canUse
      canList
      triggerClassName={triggerClassName}
      sharedState={sharedState}
      setSharedState={setSharedState}
      onReloadSession={props.onReloadSession}
    />
  );
  return (
    <>
      {picker("sm:hidden")}
      {picker("max-sm:hidden")}
    </>
  );
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

describe("SessionVariableSetPicker", () => {
  test("shares first-attachment refresh recovery across responsive picker surfaces", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const reloadSession = mock(async () => {
      throw new Error("refresh unavailable");
    });

    try {
      await act(async () => root.render(<ResponsivePickerPair onReloadSession={reloadSession} />));

      const select = container.querySelectorAll("select")[0];
      if (!select) throw new Error("Variable Set select missing");
      await act(async () => {
        select.value = variableSetId;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      const save = [...container.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Save",
      );
      if (!save) throw new Error("Save button missing");
      await act(async () => {
        save.click();
        await flush();
      });

      expect(updateSessionVariableSets).toHaveBeenCalledWith(
        "33333333-3333-4333-8333-333333333333",
        "22222222-2222-4222-8222-222222222222",
        { variableSetIds: [variableSetId] },
      );
      expect(reloadSession).toHaveBeenCalledTimes(1);
      expect(container.textContent).toContain("The update committed");
      expect(container.textContent?.match(/Retry refresh/g)).toHaveLength(2);
      expect(container.textContent).toContain("Deploy credentials");
      const saveButtons = [...container.querySelectorAll("button")].filter(
        (button) => button.textContent?.trim() === "Save",
      );
      expect(saveButtons).toHaveLength(2);
      expect(saveButtons.every((button) => button.disabled)).toBe(true);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

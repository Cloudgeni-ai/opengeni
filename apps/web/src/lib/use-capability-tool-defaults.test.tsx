import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useCapabilityToolDefaults } from "./use-capability-tool-defaults";

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
afterAll(() => GlobalRegistrator.unregister());

test("new connections default on without undoing draft choices, including revocation and reconnection", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  type Props = {
    workspaceId: string;
    availableIds: string[];
    configuredIds?: string[];
    principal?: string;
  };
  function Draft({ workspaceId, availableIds, configuredIds }: Props) {
    const [selected, setSelected] = useState(new Set<string>());
    const appliedKey = useRef<string | null>(null);
    const seenIds = useRef(new Set<string>());
    useCapabilityToolDefaults({
      ready: true,
      workspaceId,
      availableIds,
      configuredIds,
      defaultIds: configuredIds
        ? configuredIds.filter((id) => availableIds.includes(id))
        : availableIds,
      appliedKey,
      seenIds,
      setSelected,
    });
    return (
      <>
        {availableIds.map((id) => (
          <label key={id}>
            {id}
            <input
              type="checkbox"
              aria-label={id}
              checked={selected.has(id)}
              onChange={() =>
                setSelected((current) => {
                  const next = new Set(current);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })
              }
            />
          </label>
        ))}
      </>
    );
  }
  const render = async (props: Props) =>
    act(async () => root.render(<Draft key={props.principal ?? "owner"} {...props} />));
  const checked = (id: string) =>
    (container.querySelector(`input[aria-label="${id}"]`) as HTMLInputElement | null)?.checked;
  const deselect = async (id: string) =>
    act(async () =>
      (container.querySelector(`input[aria-label="${id}"]`) as HTMLInputElement).click(),
    );
  await render({ workspaceId: "a", availableIds: ["drive", "calendar"] });
  expect(checked("drive")).toBe(true);
  await deselect("drive");
  await render({ workspaceId: "a", availableIds: ["drive", "calendar", "new"] });
  expect(checked("drive")).toBe(false);
  expect(checked("new")).toBe(true);
  await render({ workspaceId: "a", availableIds: ["calendar", "new"] });
  expect(checked("drive")).toBeUndefined();
  await render({ workspaceId: "a", availableIds: ["drive", "calendar", "new"] });
  expect(checked("drive")).toBe(false);
  await render({
    workspaceId: "a",
    availableIds: ["drive", "calendar", "new"],
    configuredIds: ["drive"],
  });
  expect(checked("drive")).toBe(true);
  expect(checked("calendar")).toBe(false);
  await render({
    workspaceId: "a",
    availableIds: ["drive", "calendar", "new", "other"],
    configuredIds: ["drive"],
  });
  expect(checked("other")).toBe(false);
  await render({ workspaceId: "a", availableIds: ["drive"], configuredIds: [] });
  expect(checked("drive")).toBe(false);
  await render({ workspaceId: "b", availableIds: ["drive"] });
  expect(checked("drive")).toBe(true);
  await deselect("drive");
  await render({ workspaceId: "b", availableIds: ["drive"], principal: "member" });
  expect(checked("drive")).toBe(true);
  await act(async () => root.unmount());
});

import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { VariableSetShortlistEditor } from "./variable-set-shortlist-editor";
import { variableSetRuntimeIds } from "@/lib/variable-set-shortlist";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());

test("large searchable catalog stays scroll bounded and caps enabled sets, not shortlist rows", async () => {
  const catalog = Array.from({ length: 30 }, (_, i) => ({
    id: String(i),
    name: `Set ${String(i).padStart(2, "0")}`,
  }));
  let latest = catalog.map((set, index) => ({ id: set.id, enabled: index < 25 }));
  function Panel() {
    const [rows, setRows] = useState(latest);
    return (
      <VariableSetShortlistEditor
        rows={rows}
        variableSets={catalog}
        disabled={false}
        canAdd
        onChange={(next) => {
          latest = next;
          setRows(next);
        }}
      />
    );
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const button = (label: string) =>
    container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
  try {
    await act(async () => root.render(<Panel />));
    expect(container.querySelectorAll('[role="switch"]')).toHaveLength(30);
    expect(container.querySelector(".max-h-\\[300px\\]")?.className).toContain("overflow-y-auto");
    expect(button("Enable Set 25").disabled).toBe(true);
    expect(button("Move Set 25 earlier").disabled).toBe(true);
    await act(async () => button("Enable Set 00").click());
    expect(latest.map((row) => row.id)).toEqual(catalog.map((set) => set.id));
    expect(button("Enable Set 25").disabled).toBe(false);
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((candidate) => candidate.textContent?.includes("Add variable sets"))!
        .click(),
    );
    expect(container.querySelectorAll('[role="switch"]')).toHaveLength(30);
    await act(async () => button("Enable Set 25").click());
    expect(variableSetRuntimeIds(latest)).toHaveLength(25);
    expect(button("Enable Set 26").disabled).toBe(true);
    const input = container.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "Set 29",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelectorAll('[role="switch"]')).toHaveLength(1);
    expect(container.textContent).toContain("Set 29");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

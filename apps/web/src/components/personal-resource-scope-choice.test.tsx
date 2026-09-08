import { afterEach, expect, test } from "bun:test";
import { useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { actRun, registerDom } from "../../../../packages/react/test/render-hook";
import type { PersonalAttachmentMode } from "@/lib/personal-resource-attachments";
import { PersonalResourceScopeChoice } from "./personal-resource-scope-choice";

registerDom();
let root: Root | undefined;
afterEach(async () => {
  await actRun(() => root?.unmount());
  document.body.replaceChildren();
});

async function mount(disabled = false) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  function Fixture() {
    const [mode, setMode] = useState<PersonalAttachmentMode>("once");
    return <PersonalResourceScopeChoice mode={mode} onModeChange={setMode} disabled={disabled} />;
  }
  await actRun(() => root!.render(<Fixture />));
  return container;
}

test("compact picker changes the next-send scope and discloses the access explanation", async () => {
  const container = await mount();
  const select = container.querySelector("select")!;
  expect(container.querySelector("label")?.htmlFor).toBe(select.id);
  expect(select.value).toBe("once");
  expect(container.textContent).toContain("Applies when you send");
  expect(container.textContent).not.toContain("does not revoke");
  await actRun(() => {
    select.value = "session";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(select.value).toBe("session");
  const disclosure = container.querySelector<HTMLButtonElement>("button")!;
  expect(disclosure.getAttribute("aria-label")).toBe("About personal access");
  await actRun(() => disclosure.click());
  expect(disclosure.getAttribute("aria-expanded")).toBe("true");
  expect(container.textContent).toContain("follow-up work initiated on your behalf");
  expect(container.textContent).toContain("does not revoke existing access");
});

test("unavailable resources disable scope changes but keep help accessible", async () => {
  const container = await mount(true);
  expect(container.querySelector("select")?.disabled).toBe(true);
  expect(container.querySelector("button")?.disabled).toBe(false);
});

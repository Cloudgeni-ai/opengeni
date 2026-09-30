import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { PrivateSessionIndicator, PRIVATE_SESSION_EXPLANATION } =
  await import("./private-session-indicator");

afterAll(() => GlobalRegistrator.unregister());
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

test("the header mark says Private and explains who can and can't see the chat", async () => {
  await act(async () => root.render(<PrivateSessionIndicator />));
  const mark = container.querySelector("[aria-label]")!;
  expect(mark.textContent).toBe("Private");
  expect(mark.getAttribute("aria-label")).toBe(`Private. ${PRIVATE_SESSION_EXPLANATION}`);
  expect(container.querySelector("svg.lucide-lock")).not.toBeNull();
  // Truthful to the tenancy model: admins get no access; billing sees amounts only.
  expect(PRIVATE_SESSION_EXPLANATION).toContain("Organization admins can't open it");
  expect(PRIVATE_SESSION_EXPLANATION).toContain("usage amounts");
});

test("the header and new-chat page show them only in a Personal workspace", () => {
  const rail = readFileSync(new URL("../rail/rail-shell.tsx", import.meta.url), "utf8");
  expect(rail).toMatch(
    /isPersonalWorkspace\([\s\S]{0,200}\) \? \([\s\S]{0,200}<PrivateSessionIndicator \/>/,
  );
  const index = readFileSync(new URL("../../routes/sessions-index.tsx", import.meta.url), "utf8");
  expect(index).toContain("{personalWorkspace ? <PrivateWorkspaceNote /> : null}");
  expect(index).toContain("Private: only you can see chats here.");
});

import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

const said: string[] = [];
mock.module("../../lib/toast", () => ({
  toast: Object.assign((text: string) => said.push(`info:${text}`), {
    success: (text: string) => said.push(`success:${text}`),
    error: (text: string) => said.push(`error:${text}`),
  }),
}));

let module: typeof import("./copy-artifact-link");
let ownsDom = false;
const copied: string[] = [];
let refuse = false;
beforeAll(async () => {
  ownsDom = !GlobalRegistrator.isRegistered;
  if (ownsDom) GlobalRegistrator.register({ url: "https://console.example.test/somewhere" });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        if (refuse) throw new Error("Not allowed");
        copied.push(text);
      },
    },
  });
  module = await import("./copy-artifact-link");
});
afterAll(async () => {
  if (ownsDom) await GlobalRegistrator.unregister();
});
beforeEach(() => {
  copied.length = 0;
  said.length = 0;
  refuse = false;
});

async function click(kind: Parameters<typeof module.CopyArtifactLinkButton>[0]["item"]["kind"]) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(<module.CopyArtifactLinkButton workspaceId="ws 1" item={{ kind, id: "art-1" }} />),
  );
  const button = host.querySelector<HTMLButtonElement>("[data-copy-artifact-link]")!;
  expect(button.getAttribute("aria-label")).toBe("Copy link");
  await act(async () => button.click());
  await act(async () => root.unmount());
  host.remove();
}

test("Copy link copies the artifact's own address and says Link copied, like a chat's", async () => {
  await click("document");
  await click("spreadsheet");
  await click("image");
  await click("file");
  await click("site");
  expect(copied).toEqual([
    "https://console.example.test/workspaces/ws%201/artifacts/editable/art-1",
    "https://console.example.test/workspaces/ws%201/artifacts/editable/art-1",
    "https://console.example.test/workspaces/ws%201/artifacts/files/art-1",
    "https://console.example.test/workspaces/ws%201/artifacts/files/art-1",
    "https://console.example.test/workspaces/ws%201/sites/art-1",
  ]);
  expect(said).toEqual(Array.from({ length: 5 }, () => "success:Link copied"));
});

test("a refused clipboard says the link couldn't be copied", async () => {
  refuse = true;
  await click("document");
  expect(copied).toEqual([]);
  expect(said).toEqual(["error:Couldn't copy the link."]);
});

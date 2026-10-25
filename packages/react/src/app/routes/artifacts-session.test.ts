import { describe, expect, mock, test } from "bun:test";

import { newArtifactPrompt } from "../lib/site-edit-prompt";

const source = await Bun.file(new URL("./artifacts.tsx", import.meta.url)).text();

// Exercise the route callbacks without mounting the unrelated sandbox/preview runtime.
function body(name: string, signature: string) {
  const start = source.indexOf(`  const ${name} = ${signature} => {`);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("\n  };", start);
  return source.slice(start, end + 5);
}

function startSession() {
  return new Function(
    "deps",
    "workspaceId",
    "filters = { kind: 'all' }",
    `const { context, navigate, readyNewChat, toast, newArtifactPrompt } = deps;
     const userErrorText = (error) => String(error);
     const preparingNew = false;
     const setPreparingNew = () => {};
     ${body("startSession", "async ()")}; return startSession();`,
  );
}

function startEditSession() {
  return new Function(
    "deps",
    "detail",
    "canPublish = true",
    `const { openSiteView } = deps;
     ${body("startEditSession", "()")}; return startEditSession();`,
  );
}

function deps(readyNewChat = mock(async (..._args: unknown[]) => {})) {
  return {
    context: { client: { id: "client" } },
    navigate: mock(async (..._args: unknown[]) => {}),
    openSiteView: mock((..._args: unknown[]) => {}),
    readyNewChat,
    toast: { error: mock((..._args: unknown[]) => {}) },
    newArtifactPrompt,
  };
}

const site = { artifact: { id: "artifact-1", title: "Status board", status: "active" } };

describe("New artifact chat", () => {
  test("readies the new-chat composer without sending, then opens it", async () => {
    const d = deps();
    await startSession()(d, "workspace-1");
    expect(d.readyNewChat.mock.calls).toEqual([
      [{ id: "client" }, "workspace-1", "Create a workspace artifact: "],
    ]);
    expect(d.navigate.mock.calls).toEqual([
      [{ to: "/workspaces/$workspaceId/sessions", params: { workspaceId: "workspace-1" } }],
    ]);
  });

  test("stays put and explains when the draft can't be saved", async () => {
    const d = deps(
      mock(async () => {
        throw new Error("offline");
      }),
    );
    await startSession()(d, "workspace-1");
    expect(d.navigate).not.toHaveBeenCalled();
    expect(d.toast.error).toHaveBeenCalledTimes(1);
  });

  test("follows the selected artifact type without inventing its contents", async () => {
    const d = deps();
    await startSession()(d, "workspace-1", { kind: "image" });
    expect(d.readyNewChat.mock.calls[0]?.[2]).toBe("Create a workspace image: ");
  });
});

describe("Edit with Opengeni", () => {
  test("opens the Site view with a new conversation beside the Site, not a separate chat", () => {
    const d = deps();
    startEditSession()(d, site);
    expect(d.openSiteView.mock.calls).toEqual([[true]]);
    expect(d.readyNewChat).not.toHaveBeenCalled();
    expect(d.navigate).not.toHaveBeenCalled();
  });

  test("waits for the Site to load", () => {
    const d = deps();
    startEditSession()(d, null);
    expect(d.openSiteView).not.toHaveBeenCalled();
  });

  test("is not offered to people who can't publish", () => {
    const d = deps();
    startEditSession()(d, site, false);
    expect(d.openSiteView).not.toHaveBeenCalled();
  });

  test("is not offered for an archived Site", () => {
    const d = deps();
    startEditSession()(d, { artifact: { ...site.artifact, status: "archived" } });
    expect(d.openSiteView).not.toHaveBeenCalled();
  });
});

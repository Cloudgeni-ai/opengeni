import { describe, expect, mock, test } from "bun:test";

import { newArtifactPrompt, siteEditPrompt } from "@/lib/site-edit-prompt";

const source = await Bun.file(new URL("./artifacts.tsx", import.meta.url)).text();

// Exercise the route callbacks without mounting the unrelated sandbox/preview runtime.
function handler(name: string) {
  const start = source.indexOf(`  const ${name} = async () => {`);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("\n  };", start);
  return new Function(
    "deps",
    "workspaceId",
    "detail",
    "filters = { kind: 'all' }",
    "canPublish = true",
    `const { context, navigate, readyNewChat, toast } = deps;
     const { newArtifactPrompt, siteEditPrompt } = deps.prompts;
     const userErrorText = (error) => String(error);
     const preparingNew = false, preparingEdit = false;
     const setPreparingNew = () => {}, setPreparingEdit = () => {};
     ${source.slice(start, end + 5)}; return ${name}();`,
  );
}

function deps(readyNewChat = mock(async (..._args: unknown[]) => {})) {
  return {
    context: { client: { id: "client" } },
    navigate: mock(async (..._args: unknown[]) => {}),
    readyNewChat,
    toast: { error: mock((..._args: unknown[]) => {}) },
    prompts: { newArtifactPrompt, siteEditPrompt },
  };
}

const site = { artifact: { id: "artifact-1", title: "Status board" } };

describe("Site session shortcuts", () => {
  for (const name of ["startSession", "startEditSession"]) {
    test(`${name} readies the new-chat composer without sending, then opens it`, async () => {
      const d = deps();
      await handler(name)(d, "workspace-1", site);
      expect(d.readyNewChat.mock.calls).toEqual([
        [
          { id: "client" },
          "workspace-1",
          name === "startSession"
            ? "Create a workspace artifact: "
            : "Edit the Site “Status board” (/workspaces/workspace-1/artifacts/artifact-1): ",
        ],
      ]);
      expect(d.navigate.mock.calls).toEqual([
        [{ to: "/workspaces/$workspaceId/sessions", params: { workspaceId: "workspace-1" } }],
      ]);
    });

    test(`${name} stays put and explains when the draft can't be saved`, async () => {
      const d = deps(
        mock(async () => {
          throw new Error("offline");
        }),
      );
      await handler(name)(d, "workspace-1", site);
      expect(d.navigate).not.toHaveBeenCalled();
      expect(d.toast.error).toHaveBeenCalledTimes(1);
    });
  }

  test("editing waits for the Site identity to load", async () => {
    const d = deps();
    await handler("startEditSession")(d, "workspace-1", null);
    expect(d.readyNewChat).not.toHaveBeenCalled();
  });
  test("read-only viewers cannot start edit sessions", async () => {
    const d = deps();
    await handler("startEditSession")(d, "workspace-1", site, undefined, false);
    expect(d.readyNewChat).not.toHaveBeenCalled();
    expect(d.navigate).not.toHaveBeenCalled();
  });
  test("creation follows the selected artifact type without inventing its contents", async () => {
    const d = deps();
    await handler("startSession")(d, "workspace-1", null, { kind: "image" });
    expect(d.readyNewChat.mock.calls[0]?.[2]).toBe("Create a workspace image: ");
  });
  test("archived Sites cannot start edit sessions", async () => {
    const d = deps();
    await handler("startEditSession")(d, "workspace-1", {
      artifact: { ...site.artifact, status: "archived" },
    });
    expect(d.readyNewChat).not.toHaveBeenCalled();
  });
});

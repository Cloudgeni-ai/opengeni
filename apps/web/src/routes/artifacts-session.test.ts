import { describe, expect, mock, test } from "bun:test";

const source = await Bun.file(new URL("./artifacts.tsx", import.meta.url)).text();

// Exercise the route callbacks without mounting the unrelated sandbox/preview runtime.
function handler(name: string) {
  const start = source.indexOf(`  const ${name} = async () => {`);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("\n  };", start);
  return new Function(
    "context",
    "navigate",
    "workspaceId",
    "detail",
    `${source.slice(start, end + 5)}; return ${name}();`,
  );
}

describe("Site session shortcuts", () => {
  for (const name of ["startSession", "startEditSession"]) {
    test(`${name} submits only a user prompt and navigates to the created session`, async () => {
      const startSession = mock(async (..._args: unknown[]) => ({ id: "session-1" }));
      const navigate = mock(async (..._args: unknown[]) => {});
      await handler(name)({ startSession }, navigate, "workspace-1", {
        artifact: { id: "artifact-1", title: "Status board" },
      });
      expect(startSession.mock.calls).toEqual([
        [
          "workspace-1",
          {
            text:
              name === "startSession"
                ? "Help me build a workspace Site."
                : "Help me edit the Site “Status board”: /workspaces/workspace-1/artifacts/artifact-1",
          },
        ],
      ]);
      expect(navigate.mock.calls).toEqual([
        [
          {
            to: "/workspaces/$workspaceId/sessions/$sessionId",
            params: { workspaceId: "workspace-1", sessionId: "session-1" },
          },
        ],
      ]);
    });

    test(`${name} does not navigate when session creation fails`, async () => {
      const navigate = mock(async () => {});
      await handler(name)({ startSession: async () => null }, navigate, "workspace-1", {
        artifact: { id: "artifact-1", title: "Status board" },
      });
      expect(navigate).not.toHaveBeenCalled();
    });
  }

  test("editing waits for the Site identity to load", async () => {
    const startSession = mock(async () => null);
    await handler("startEditSession")({ startSession }, mock(), "workspace-1", null);
    expect(startSession).not.toHaveBeenCalled();
  });

  test("archived Sites cannot start edit sessions", async () => {
    const startSession = mock(async () => null);
    await handler("startEditSession")({ startSession }, mock(), "workspace-1", {
      artifact: { id: "artifact-1", title: "Status board", status: "archived" },
    });
    expect(startSession).not.toHaveBeenCalled();
  });
});

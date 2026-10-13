import { describe, expect, test } from "bun:test";

import type { AccessContext } from "@/types";
import { secretSaveTargets, webSecretsUi } from "./secrets-ui";

function access(permissions: string[], workspaceId = "workspace-a"): AccessContext {
  return {
    mode: "managed",
    subjectId: "user-a",
    accountGrants: [],
    workspaceGrants: [{ workspaceId, accountId: "account-a", subjectId: "user-a", permissions }],
    defaultAccountId: "account-a",
    defaultWorkspaceId: workspaceId,
  } as AccessContext;
}

describe("secret save targets", () => {
  test("Only me and This task need no extra permission", () => {
    expect(secretSaveTargets(access(["sessions:create"]), "workspace-a")).toEqual(["user", "task"]);
    expect(secretSaveTargets(null, "workspace-a")).toEqual(["user", "task"]);
  });

  test("This workspace needs secrets:write, a legacy alias or workspace admin", () => {
    for (const permission of ["secrets:write", "variable-sets:write", "workspace:admin"]) {
      expect(secretSaveTargets(access([permission]), "workspace-a")).toEqual([
        "user",
        "task",
        "workspace",
      ]);
    }
    expect(secretSaveTargets(access(["secrets:use", "secrets:list"]), "workspace-a")).toEqual([
      "user",
      "task",
    ]);
  });

  test("a grant in another workspace does not count", () => {
    expect(secretSaveTargets(access(["secrets:write"], "workspace-b"), "workspace-a")).toEqual([
      "user",
      "task",
    ]);
  });
});

describe("webSecretsUi", () => {
  test("uses the one reference grammar and the shared generator", () => {
    const tokens = webSecretsUi.tokenize("use {{secret:GitHub/password}} not {{secret:}}");
    expect(tokens.map((token) => token.type)).toEqual(["text", "reference", "text", "invalid"]);
    const password = webSecretsUi.generatePassword({ length: 24 });
    expect(password).toHaveLength(24);
    expect(webSecretsUi.passwordStrength?.(password).bits).toBeGreaterThan(100);
  });
});

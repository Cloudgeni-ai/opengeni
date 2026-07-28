import { describe, expect, test } from "bun:test";

import { repositoryBindingPresentation } from "@/components/repository-picker";

describe("repository picker GitHub binding status", () => {
  test("projects configured-but-unbound as actionable and never healthy", () => {
    const url = "https://api.opengeni.test/v1/workspaces/workspace/github/connect?state=fresh";
    const presentation = repositoryBindingPresentation("unbound", url);
    expect(presentation).toMatchObject({
      connectUrl: url,
      connectLabel: "Connect GitHub",
      healthy: false,
      canRefresh: false,
    });
    expect(presentation.setupDescription).toContain("no usable installation binding");
    expect(presentation.emptyDescription).toContain("no active installation binding");
    expect(presentation.emptyDescription).toContain("repository administrators");
  });

  test("projects bound-empty as healthy with truthful provider-policy copy", () => {
    const presentation = repositoryBindingPresentation(
      "bound",
      "https://api.opengeni.test/github/connect",
    );
    expect(presentation).toMatchObject({
      connectLabel: "Configure another installation",
      healthy: true,
      canRefresh: true,
    });
    expect(presentation.emptyDescription).toContain("none of its explicitly allowed repositories");
    expect(presentation.emptyDescription).toContain("policy approval");
  });

  test("projects disabled without a connect URL or healthy controls", () => {
    const presentation = repositoryBindingPresentation(
      "disabled",
      "https://api.opengeni.test/must-not-be-used",
    );
    expect(presentation).toMatchObject({
      connectUrl: null,
      healthy: false,
      canRefresh: false,
    });
    expect(presentation.emptyDescription).toContain("not configured");
  });
});

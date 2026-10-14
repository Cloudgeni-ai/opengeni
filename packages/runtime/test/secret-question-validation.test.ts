import { describe, expect, test } from "bun:test";
import { RequestHumanInputToolInput } from "@opengeni/contracts";
import { secretQuestionRejection } from "../src/index";

function request(secret: Record<string, unknown> | null, kind = "secret") {
  return RequestHumanInputToolInput.parse({
    questions: [
      {
        id: "q1",
        kind,
        prompt: "GitHub password",
        label: null,
        helpText: null,
        skillReview: null,
        options: [],
        required: true,
        allowOther: false,
        validation: null,
        secret,
      },
    ],
    allowSkip: true,
    expiresInSeconds: null,
  });
}

describe("request_human_input secret questions (AC-1)", () => {
  test("a valid secret question passes", async () => {
    expect(
      await secretQuestionRejection(request({ item: "GitHub", saveTo: "user" }), {
        enabled: true,
        hasActingHuman: true,
      }),
    ).toBeNull();
  });

  test("strict-schema nulls are treated as absent", async () => {
    expect(
      await secretQuestionRejection(
        request({
          item: "GitHub",
          saveTo: "workspace",
          vault: null,
          username: null,
          website: null,
          looksLike: null,
          pattern: null,
          generate: null,
        }),
        { enabled: true, hasActingHuman: false },
      ),
    ).toBeNull();
  });

  test("rejected when the secrets capability is off", async () => {
    expect(
      await secretQuestionRejection(request({ item: "GitHub", saveTo: "workspace" }), {
        enabled: false,
        hasActingHuman: true,
      }),
    ).toContain("turned off");
  });

  test("text questions are unaffected when secrets are off", async () => {
    expect(
      await secretQuestionRejection(request(null, "text"), {
        enabled: false,
        hasActingHuman: false,
      }),
    ).toBeNull();
  });

  test("Only me requires an acting human", async () => {
    const reason = await secretQuestionRejection(request({ item: "GitHub", saveTo: "user" }), {
      enabled: true,
      hasActingHuman: false,
    });
    expect(reason).toContain("Only me");
    expect(
      await secretQuestionRejection(request({ item: "GitHub", saveTo: "task" }), {
        enabled: true,
        hasActingHuman: false,
      }),
    ).toBeNull();
  });

  test("a provider vault is rejected through the host check (Q-05)", async () => {
    const seen: unknown[] = [];
    const reason = await secretQuestionRejection(
      request({ item: "GitHub", saveTo: "workspace", vault: "Team 1Password" }),
      {
        enabled: true,
        hasActingHuman: true,
        validateQuestionVault: async (input) => {
          seen.push(input);
          return "it is a connected 1Password vault; answers are saved to Opengeni vaults only.";
        },
      },
    );
    expect(seen).toEqual([{ vault: "Team 1Password", saveTo: "workspace" }]);
    expect(reason).toContain("1Password");
  });
});

import { describe, expect, test } from "bun:test";
import { RequestHumanInputToolInput } from "@opengeni/contracts";
import { secretApprovalQuestionRejection, secretQuestionRejection } from "../src/index";

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

  test("a vault check that cannot complete is a rejection, not a thrown error", async () => {
    const reason = await secretQuestionRejection(
      request({ item: "GitHub", saveTo: "workspace", vault: "Team" }),
      {
        enabled: true,
        hasActingHuman: true,
        validateQuestionVault: async () => {
          throw new Error("vault store is unavailable");
        },
      },
    );
    expect(reason).toContain("could not be checked");
    expect(reason).toContain("vault store is unavailable");
  });
});

describe("request_human_input secret approval questions", () => {
  const ask = (id: string) =>
    RequestHumanInputToolInput.parse({
      questions: [
        {
          id,
          kind: "single_select",
          prompt: "Allow the agent to use GitHub › password?",
          label: null,
          helpText: null,
          skillReview: null,
          options: [
            { id: "once", label: "Allow once", description: null },
            { id: "deny", label: "Deny", description: null },
          ],
          required: true,
          allowOther: false,
          validation: null,
          secret: null,
        },
      ],
      allowSkip: false,
      expiresInSeconds: null,
    });

  test("an agent cannot ask with Opengeni's approval card; the person was already asked", () => {
    const reason = secretApprovalQuestionRejection(
      ask("secret-approval:0f8fad5b-d9cb-469f-a165-70867728950e"),
    );
    expect(reason).toBe(
      "Nothing was asked. Opengeni already asked the person, in this chat and by notification, to allow that use of the secret, and their answer reaches you as an update in this chat. Do not ask them again; if they allow it, retry the same call.",
    );
  });

  test("ordinary questions pass", () => {
    expect(secretApprovalQuestionRejection(ask("environment"))).toBeNull();
  });
});

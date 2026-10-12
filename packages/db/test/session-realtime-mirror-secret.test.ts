import { expect, test } from "bun:test";
import { renderRealtimeHumanInputRequestContext } from "../src/session-realtime-mirror";

test("voice context names a secret question but sends the user to the app (AC-5)", () => {
  const text = renderRealtimeHumanInputRequestContext({
    requests: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        allowSkip: true,
        expiresAt: null,
        questions: [
          {
            id: "secret_1",
            kind: "secret",
            prompt: "Enter the password for GitHub.",
            label: "GitHub",
            helpText: null,
            skillReview: null,
            options: [],
            required: true,
            allowOther: false,
            validation: null,
            secret: {
              item: "GitHub",
              field: "password",
              fieldKind: "concealed",
              itemType: "login",
              saveTo: "user",
              allowGenerate: false,
              autocomplete: "current-password",
            },
          },
        ],
      },
    ],
  } as Parameters<typeof renderRealtimeHumanInputRequestContext>[0]);
  expect(text).toContain("<kind>secret</kind>");
  expect(text).toContain("<answer_in_app>true</answer_in_app>");
  expect(text).not.toContain("<allow_other>");
  expect(text).toContain("never ask for it aloud");
});

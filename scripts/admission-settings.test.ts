import { expect, test } from "bun:test";
import { join } from "node:path";
import { admissionSettingsReport } from "./admission-settings";

test("reports the parsed admission policy and revision, nothing else", () => {
  expect(
    admissionSettingsReport({
      OPENGENI_ALLOWED_USER_EMAILS: " A@Example.com ,b@example.com",
      OPENGENI_VERIFIED_SIGNUP_TRIAL_CREDITS_ENABLED: "true",
      OPENGENI_DEPLOYMENT_REVISION: "abc123",
      OPENGENI_DATABASE_URL: "postgres://user:secret@127.0.0.1:1/db",
    }),
  ).toEqual({
    emails: ["a@example.com", "b@example.com"],
    signupTrialMaster: true,
    sourceSha: "abc123",
  });
  expect(admissionSettingsReport({})).toEqual({
    emails: null,
    signupTrialMaster: false,
    sourceSha: null,
  });
});

test("prints one JSON line when executed and nothing when imported", () => {
  const executed = Bun.spawnSync(
    [process.execPath, "--no-env-file", join(import.meta.dir, "admission-settings.ts")],
    {
      env: {
        PATH: process.env.PATH,
        OPENGENI_ALLOWED_USER_EMAILS: "a@example.com",
        OPENGENI_DEPLOYMENT_REVISION: "abc123",
      },
    },
  );
  expect(executed.exitCode).toBe(0);
  expect(JSON.parse(executed.stdout.toString())).toEqual({
    emails: ["a@example.com"],
    signupTrialMaster: false,
    sourceSha: "abc123",
  });
});

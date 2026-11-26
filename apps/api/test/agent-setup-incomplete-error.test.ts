import { expect, test } from "bun:test";
import { HTTPException } from "hono/http-exception";
import { githubAppConfigured } from "@opengeni/core";
import { githubAppMissingSettings } from "@opengeni/github";

import { scheduledTaskTargetAccessHttpError } from "../src/http/api-error";

// A ready-made agent's trigger refused by core (any path: the API, Opengeni's
// own tools, app sync) keeps its reason and what is missing in the answer.
test("a trigger refused until its connections are on answers 409 with what is missing", () => {
  const missing = [
    { kind: "connection", provider: "github.com", name: "GitHub", reason: "Connect GitHub." },
  ];
  const error = scheduledTaskTargetAccessHttpError(
    new HTTPException(409, {
      message: "Connect GitHub to turn this on.",
      cause: { code: "agent_setup_incomplete", missing },
    }),
  );
  expect(error?.status).toBe(409);
  expect(error).toMatchObject({
    code: "conflict",
    message: "Connect GitHub to turn this on.",
    details: { code: "agent_setup_incomplete", missing },
  });
  expect(scheduledTaskTargetAccessHttpError(new HTTPException(409, { message: "x" }))).toBeNull();
});

// Readiness counts the GitHub App as connected only when it is fully set up,
// by the same settings the GitHub integration page checks.
test("readiness's GitHub App check matches githubAppMissingSettings", () => {
  const full = {
    githubAppId: "1",
    githubClientId: "client",
    githubClientSecret: "secret",
    githubAppSlug: "opengeni",
    githubAppPrivateKey: "key",
  };
  const cases = [full, ...Object.keys(full).map((key) => ({ ...full, [key]: " " }))];
  for (const settings of cases) {
    expect(githubAppConfigured(settings)).toBe(
      githubAppMissingSettings(settings as never).length === 0,
    );
  }
});

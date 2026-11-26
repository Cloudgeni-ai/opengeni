import { expect, test } from "bun:test";
import { HTTPException } from "hono/http-exception";

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

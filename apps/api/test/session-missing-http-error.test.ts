import { expect, test } from "bun:test";
import { SessionControlInvariantError, SessionMissingFromWorkspaceError } from "@opengeni/db";
import { sessionMissingHttpError } from "../src/http/api-error";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const sessionId = "00000000-0000-4000-8000-000000000002";
const base = "https://api.example.test/v1/workspaces";

test("a request naming the deleted session finds it gone", () => {
  const error = new SessionMissingFromWorkspaceError(sessionId);
  for (const url of [
    `${base}/${workspaceId}/sessions/${sessionId}`,
    `${base}/${workspaceId}/machines?sessionId=${sessionId}`,
    `${base}/${workspaceId}/sessions/${sessionId.toUpperCase()}`,
  ]) {
    const mapped = sessionMissingHttpError(error, url, "GET");
    expect(mapped?.status).toBe(404);
    expect(mapped?.code).toBe("not_found");
    expect(mapped?.message).toBe("session not found");
    expect(mapped?.retryable).toBe(false);
  }
});

test("any other request read a changing workspace; only a read retries blindly", () => {
  const error = new SessionMissingFromWorkspaceError(sessionId);
  const read = sessionMissingHttpError(error, `${base}/${workspaceId}/sessions?limit=50`, "GET");
  expect(read?.status).toBe(409);
  expect(read?.code).toBe("conflict");
  expect(read?.retryable).toBe(true);
  expect(read?.outcomeUnknown).toBe(false);
  const write = sessionMissingHttpError(error, `${base}/${workspaceId}/sessions`, "POST");
  expect(write?.status).toBe(409);
  expect(write?.retryable).toBe(false);
  expect(write?.outcomeUnknown).toBe(true);
});

test("other session control invariant failures stay server errors", () => {
  expect(
    sessionMissingHttpError(
      new SessionControlInvariantError(`Session ${sessionId} has cyclic ancestry`),
      `${base}/${workspaceId}/sessions/${sessionId}`,
      "GET",
    ),
  ).toBeNull();
});

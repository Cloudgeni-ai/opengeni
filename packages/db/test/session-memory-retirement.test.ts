import { expect, test } from "bun:test";
import {
  CreateSessionRequest,
  SessionMemoryScope,
  storedSessionMemoryScope,
} from "@opengeni/contracts";
import { memoryReadScopesForAgentScope, memoryWriteScopeForAgentScope } from "../src/memory-domain";

test("new session-memory selection is rejected; historical selectors disable Memory without widening", () => {
  expect(SessionMemoryScope.safeParse("session").success).toBe(false);
  expect(storedSessionMemoryScope("session")).toBe("off");
  expect(storedSessionMemoryScope("user")).toBe("user");
  expect(storedSessionMemoryScope("workspace")).toBe("workspace");
  expect(() => storedSessionMemoryScope("invalid")).toThrow();
  const retired = {
    mode: storedSessionMemoryScope("session"),
    userSubjectId: null,
    rootSessionId: "old-root",
  };
  expect(memoryWriteScopeForAgentScope(retired)).toBeNull();
  expect(memoryReadScopesForAgentScope(retired)).toEqual([]);
});

test("public session creation cannot assert a canonical user or legacy label", () => {
  const request = { initialMessage: "hello" };
  expect(CreateSessionRequest.safeParse(request).success).toBe(true);
  expect(CreateSessionRequest.safeParse({ ...request, scopeSubjectId: "user:other" }).success).toBe(
    false,
  );
  expect(
    CreateSessionRequest.safeParse({ ...request, endUser: { source: "app", id: "other" } }).success,
  ).toBe(false);
  expect(CreateSessionRequest.safeParse({ ...request, memoryScope: "session" }).success).toBe(
    false,
  );
  expect(CreateSessionRequest.safeParse({ ...request, memoryScope: "user" }).success).toBe(true);
});

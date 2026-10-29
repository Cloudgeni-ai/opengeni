import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import { NEW_CHAT_WORDING, rememberSignupUseCase, signupStarterSet } from "./signup-starter-set";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());
beforeEach(() => localStorage.clear());

test("adding agents to a product leads with the product set, for that account and organization only", () => {
  rememberSignupUseCase({ account: "Ada@Example.test", organizationId: "org-a", useCase: "embed" });
  expect(signupStarterSet("ada@example.test", "org-a")).toBe("product");
  expect(signupStarterSet("ada@example.test", "org-b")).toBe("everyday");
  expect(signupStarterSet("grace@example.test", "org-a")).toBe("everyday");
  expect(signupStarterSet(null, "org-a")).toBe("everyday");
  expect(signupStarterSet("ada@example.test", undefined)).toBe("everyday");
});

test("running agents in the cloud, a later answer, and unreadable storage", () => {
  rememberSignupUseCase({ account: "ada@example.test", organizationId: "org-a", useCase: "cloud" });
  expect(signupStarterSet("ada@example.test", "org-a")).toBe("general");
  expect(signupStarterSet(null, "org-a", "cloud")).toBe("general");
  rememberSignupUseCase({ account: "ada@example.test", organizationId: "org-a", useCase: "embed" });
  expect(signupStarterSet("ada@example.test", "org-a")).toBe("product");
  localStorage.setItem("opengeni.signupUseCase.v1", "not json");
  expect(signupStarterSet("ada@example.test", "org-a")).toBe("everyday");
});

test("no answer (skipped the question, or signed up before it existed) gets the everyday set", () => {
  expect(signupStarterSet("ada@example.test", "org-a")).toBe("everyday");
  expect(signupStarterSet("ada@example.test", "org-a", undefined)).toBe("everyday");
  expect(signupStarterSet(undefined, undefined)).toBe("everyday");
});

test("help with everyday things leads with the everyday set, for that account and organization only", () => {
  rememberSignupUseCase({
    account: "Ada@Example.test",
    organizationId: "org-a",
    useCase: "everyday",
  });
  expect(signupStarterSet("ada@example.test", "org-a")).toBe("everyday");
  rememberSignupUseCase({ account: "grace@example.test", organizationId: "org-a", useCase: "cloud" });
  expect(signupStarterSet("grace@example.test", "org-a")).toBe("general");
  expect(signupStarterSet("ada@example.test", "org-a")).toBe("everyday");
});

test("keeps the newest twenty organizations", () => {
  for (let index = 0; index < 25; index += 1)
    rememberSignupUseCase({
      account: "ada@example.test",
      organizationId: `org-${index}`,
      useCase: "embed",
    });
  expect(signupStarterSet("ada@example.test", "org-0")).toBe("everyday");
  expect(signupStarterSet("ada@example.test", "org-24")).toBe("product");
  expect(Object.keys(JSON.parse(localStorage.getItem("opengeni.signupUseCase.v1")!))).toHaveLength(
    20,
  );
});

test("the server's current answer wins on any device", () => {
  // A fresh browser: nothing stored here, the server knows the answer.
  expect(signupStarterSet("ada@example.test", "org-a", "embed")).toBe("product");
  expect(signupStarterSet(null, "org-a", "embed")).toBe("product");
  // Back, then another answer on another device: the server's answer wins.
  rememberSignupUseCase({ account: "ada@example.test", organizationId: "org-a", useCase: "embed" });
  expect(signupStarterSet("ada@example.test", "org-a", "everyday")).toBe("everyday");
  // Without a server answer (an older server or organization) this browser decides.
  expect(signupStarterSet("ada@example.test", "org-a", undefined)).toBe("product");
});

test("every signup answer gets the same plain heading, placeholder and label", () => {
  expect(NEW_CHAT_WORDING).toEqual({
    heading: "What can I help with?",
    placeholder: "Ask anything, or describe what you need…",
    composerMessages: { inputLabel: "Ask anything" },
  });
});

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import { rememberSignupUseCase, signupStarterSet } from "./signup-starter-set";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());
beforeEach(() => localStorage.clear());

test("adding agents to a product leads with the product set, for that account and organization only", () => {
  rememberSignupUseCase({ account: "Ada@Example.test", organizationId: "org-a", useCase: "embed" });
  expect(signupStarterSet("ada@example.test", "org-a")).toBe("product");
  expect(signupStarterSet("ada@example.test", "org-b")).toBe("general");
  expect(signupStarterSet("grace@example.test", "org-a")).toBe("general");
  expect(signupStarterSet(null, "org-a")).toBe("general");
  expect(signupStarterSet("ada@example.test", undefined)).toBe("general");
});

test("running agents in the cloud, a later answer, and unreadable storage", () => {
  rememberSignupUseCase({ account: "ada@example.test", organizationId: "org-a", useCase: "cloud" });
  expect(signupStarterSet("ada@example.test", "org-a")).toBe("general");
  rememberSignupUseCase({ account: "ada@example.test", organizationId: "org-a", useCase: "embed" });
  expect(signupStarterSet("ada@example.test", "org-a")).toBe("product");
  localStorage.setItem("opengeni.signupUseCase.v1", "not json");
  expect(signupStarterSet("ada@example.test", "org-a")).toBe("general");
});

test("help with everyday things leads with the everyday set, for that account and organization only", () => {
  rememberSignupUseCase({
    account: "Ada@Example.test",
    organizationId: "org-a",
    useCase: "everyday",
  });
  expect(signupStarterSet("ada@example.test", "org-a")).toBe("everyday");
  expect(signupStarterSet("ada@example.test", "org-b")).toBe("general");
  expect(signupStarterSet("grace@example.test", "org-a")).toBe("general");
});

test("keeps the newest twenty organizations", () => {
  for (let index = 0; index < 25; index += 1)
    rememberSignupUseCase({
      account: "ada@example.test",
      organizationId: `org-${index}`,
      useCase: "embed",
    });
  expect(signupStarterSet("ada@example.test", "org-0")).toBe("general");
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

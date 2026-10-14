import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import {
  clearPendingDeveloperSetup,
  pendingDeveloperSetupFor,
  rememberPendingDeveloperSetup,
} from "./pending-developer-setup";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());
beforeEach(() => window.localStorage.clear());

const setup = {
  account: "maria@example.com",
  organizationId: "org-1",
  organizationName: "Northwind",
};

test("a remembered developer setup comes back for the same account only", () => {
  rememberPendingDeveloperSetup(setup, 1_000);
  expect(pendingDeveloperSetupFor("Maria@Example.com", 2_000)).toMatchObject({
    organizationId: "org-1",
    organizationName: "Northwind",
  });
  expect(pendingDeveloperSetupFor("someone@else.com", 2_000)).toBeNull();
  expect(pendingDeveloperSetupFor(null, 2_000)).toBeNull();
});

test("it expires after a week and clears when the step is done", () => {
  rememberPendingDeveloperSetup(setup, 0);
  expect(pendingDeveloperSetupFor(setup.account, 8 * 24 * 60 * 60 * 1000)).toBeNull();
  rememberPendingDeveloperSetup(setup, 0);
  clearPendingDeveloperSetup();
  expect(pendingDeveloperSetupFor(setup.account, 1)).toBeNull();
});

test("a malformed stored value is ignored", () => {
  window.localStorage.setItem("opengeni.pendingDeveloperSetup.v1", "{not json");
  expect(pendingDeveloperSetupFor(setup.account)).toBeNull();
});

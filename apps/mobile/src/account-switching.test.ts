import { expect, test } from "bun:test";
import type { AccountsSnapshot, StoredAccount } from "./account-store";
import {
  accountMenuTitle,
  planAccountPick,
  signInSwitchChoices,
  wayBackWhenLeaving,
} from "./account-switching";

const account = (id: string, patch: Partial<StoredAccount> = {}): StoredAccount => ({
  id,
  baseUrl: "https://app.opengeni.ai",
  subjectId: `user:${id}`,
  email: `${id}@example.com`,
  workspaceId: null,
  ...patch,
});

const work = account("work");
const old = account("old", { signedOut: true, baseUrl: "https://staging.opengeni.ai" });
const home = account("home");
const snapshot: AccountsSnapshot = { accounts: [work, old, home], activeId: "work" };

test("picking a signed-out account opens its sign-in and keeps the account in use", () => {
  expect(planAccountPick(snapshot, "old", true)).toEqual({ kind: "signIn", account: old });
  // No stored credential means signed out too, whatever the saved flag says.
  expect(planAccountPick(snapshot, "home", false)).toEqual({ kind: "signIn", account: home });
});

test("picking a signed-in account switches at once, leaving every account's sign-in alone", () => {
  const pick = planAccountPick(snapshot, "home", true);
  expect(pick).toEqual({ kind: "switch", next: { accounts: snapshot.accounts, activeId: "home" } });
  expect(planAccountPick(snapshot, "work", true)).toEqual({ kind: "stay" });
  expect(planAccountPick(snapshot, "missing", true)).toEqual({ kind: "stay" });
});

test("the full-screen sign-in offers the other accounts, the one you came from first", () => {
  const stuck: StoredAccount[] = [work, old, home];
  expect(signInSwitchChoices(stuck, "old", "home")).toEqual([
    { account: home, signedIn: true },
    { account: work, signedIn: true },
  ]);
  expect(signInSwitchChoices(stuck, "home", null)).toEqual([
    { account: work, signedIn: true },
    { account: old, signedIn: false },
  ]);
  expect(signInSwitchChoices([old], "old", null)).toEqual([]);
  // A way back that has since been signed out no longer leads the list.
  expect(signInSwitchChoices(stuck, "home", "old")).toEqual([
    { account: work, signedIn: true },
    { account: old, signedIn: false },
  ]);
});

test("account menus say which accounts must sign in again", () => {
  expect(accountMenuTitle(work, 1)).toBe("work@example.com");
  expect(accountMenuTitle(old, 1)).toBe("old@example.com · Signed out");
  expect(accountMenuTitle(old, 2)).toBe("old@example.com · staging.opengeni.ai · Signed out");
});

test("the way back is the signed-in account you left, kept through signed-out ones", () => {
  // On work, picking home: work is the way back.
  expect(wayBackWhenLeaving(snapshot, "home", null)).toBe("work");
  // On signed-out old (came from work), picking another: still work.
  const onOld = { ...snapshot, activeId: "old" };
  expect(wayBackWhenLeaving(onOld, "home", "work")).toBe("work");
  expect(wayBackWhenLeaving(snapshot, "work", "home")).toBe("home");
});

import { describe, expect, test } from "bun:test";
import { memberEmail, memberEmailDetail, memberName } from "./organization-people-model";

describe("an account without an email address", () => {
  const passkeyOnly = { name: "Ada", email: "0b7f6c1e@passkey.invalid" };

  test("is shown by name, and its placeholder address never appears", () => {
    expect(memberEmail(passkeyOnly)).toBeNull();
    expect(memberEmailDetail(passkeyOnly, "Ada")).toBeUndefined();
    expect(memberName(passkeyOnly)).toBe("Ada");
    expect(memberName({ name: null, email: passkeyOnly.email })).toBe("Unnamed person");
  });

  test("leaves real addresses as they were", () => {
    const person = { name: "Grace", email: "grace@example.test" };
    expect(memberEmail(person)).toBe("grace@example.test");
    expect(memberEmailDetail(person, "Grace")).toBe("grace@example.test");
    expect(memberEmailDetail(person, "grace@example.test")).toBeUndefined();
    expect(memberName({ name: null, email: person.email })).toBe("grace@example.test");
  });
});

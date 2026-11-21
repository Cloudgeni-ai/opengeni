import { describe, expect, test } from "bun:test";

import { delegationAgentSubject } from "../src/agent-delegation";

describe("delegationAgentSubject", () => {
  test("an Only me calling chat delegates to its owner's agents", () => {
    expect(
      delegationAgentSubject(
        { subjectId: "service-subject" },
        { private: true, onlyMe: true, ownerSubjectId: "owner" },
      ),
    ).toBe("owner");
    expect(
      delegationAgentSubject({ subjectId: null }, { private: true, ownerSubjectId: "owner" }),
    ).toBe("owner");
  });

  test("a shared calling chat or no caller keeps the grant's subject", () => {
    expect(
      delegationAgentSubject(
        { subjectId: "person" },
        { private: false, onlyMe: false, ownerSubjectId: "owner" },
      ),
    ).toBe("person");
    expect(delegationAgentSubject({ subjectId: "person" }, null)).toBe("person");
    expect(
      delegationAgentSubject({ subjectId: "person" }, { private: true, ownerSubjectId: null }),
    ).toBe("person");
    expect(delegationAgentSubject({ subjectId: null })).toBeNull();
  });
});

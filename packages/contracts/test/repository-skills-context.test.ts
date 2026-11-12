import { expect, test } from "bun:test";
import {
  latestRepositorySkillsIndex,
  readRepositorySkillsContext,
  REPOSITORY_SKILLS_CONTEXT_PREFIX,
  REPOSITORY_SKILLS_CONTEXT_SUFFIX,
  repositorySkillsContextItem,
} from "../src/repository-skills-context";

test("an index round-trips through its item and provider forms", () => {
  const item = repositorySkillsContextItem("### Available repository skills\n- alpha");
  expect(readRepositorySkillsContext(item)).toBe("### Available repository skills\n- alpha");
  expect(
    readRepositorySkillsContext({ type: "unknown", providerData: { ...item, role: "system" } }),
  ).toBe("### Available repository skills\n- alpha");
  expect(
    readRepositorySkillsContext({
      ...item,
      content: [{ type: "input_text", text: item.content as string }],
    }),
  ).toBe("### Available repository skills\n- alpha");
  expect(
    readRepositorySkillsContext({ type: "message", role: "user", content: item.content }),
  ).toBe(null);
});

test("stored items stay readable when the guidance wording changes", () => {
  const older = {
    type: "message",
    role: "developer",
    content: `${REPOSITORY_SKILLS_CONTEXT_PREFIX}Older guidance.\n\nIndex A${REPOSITORY_SKILLS_CONTEXT_SUFFIX}`,
  };
  expect(readRepositorySkillsContext(older)).toBe("Older guidance.\n\nIndex A");
  expect(latestRepositorySkillsIndex([older, repositorySkillsContextItem("Index B")])).toBe(
    "Index B",
  );
});

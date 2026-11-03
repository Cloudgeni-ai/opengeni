import { describe, expect, test } from "bun:test";
import { majorChangesetFailures } from "./major-changesets";

const changeset = (releases: Record<string, string>, summary = "Something changed.") => ({
  id: "x",
  summary,
  releases: Object.entries(releases).map(([name, type]) => ({ name, type })),
});

describe("major changesets", () => {
  test("a major of a public package fails without a linked compatibility exception", () => {
    expect(majorChangesetFailures([changeset({ "@opengeni/sdk": "major" })])).toHaveLength(1);
    expect(majorChangesetFailures([changeset({ "@opengeni/react": "major" })])).toHaveLength(1);
    expect(
      majorChangesetFailures([
        changeset({ "@opengeni/sdk": "major" }, "Compatibility exception: later"),
      ]),
    ).toHaveLength(1);
    expect(
      majorChangesetFailures([
        changeset(
          { "@opengeni/sdk": "major", "@opengeni/react": "major" },
          "Remove X.\n\nCompatibility exception: docs/design/api-compatibility-policy.md#exception-log",
        ),
      ]),
    ).toEqual([]);
  });

  test("minors, patches and majors of other packages pass", () => {
    expect(
      majorChangesetFailures([
        changeset({ "@opengeni/sdk": "minor", "@opengeni/react": "patch" }),
        changeset({ "@opengeni/runtime": "major" }),
        changeset({}),
      ]),
    ).toEqual([]);
  });
});

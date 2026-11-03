import { describe, expect, test } from "bun:test";
import { compatibilityException, majorReleaseFailures } from "./major-changesets";

const changeset = (releases: Record<string, string>, summary = "Something changed.") => ({
  id: "x",
  summary,
  releases: Object.entries(releases).map(([name, type]) => ({ name, type })),
});

/** The lockstep release every package gets from a major anywhere in the fixed group. */
const lockstepMajor = [
  { name: "@opengeni/sdk", type: "major" },
  { name: "@opengeni/react", type: "major" },
  { name: "@opengeni/contracts", type: "major" },
  { name: "@opengeni/runtime", type: "major" },
];
const minorRelease = [
  { name: "@opengeni/sdk", type: "minor" },
  { name: "@opengeni/react", type: "minor" },
];
const LINKED = "Compatibility exception: docs/design/api-compatibility-policy.md#exception-log";

describe("major release guard", () => {
  test("a major of a public package fails without a linked compatibility exception", () => {
    expect(
      majorReleaseFailures([changeset({ "@opengeni/sdk": "major" })], lockstepMajor),
    ).toHaveLength(1);
    expect(
      majorReleaseFailures([changeset({ "@opengeni/react": "major" })], lockstepMajor),
    ).toHaveLength(1);
    expect(
      majorReleaseFailures(
        [changeset({ "@opengeni/sdk": "major" }, "Compatibility exception: later")],
        lockstepMajor,
      ),
    ).toHaveLength(1);
    expect(
      majorReleaseFailures(
        [
          changeset(
            { "@opengeni/sdk": "major", "@opengeni/react": "major" },
            `Remove X.\n\n${LINKED}`,
          ),
        ],
        lockstepMajor,
      ),
    ).toEqual([]);
  });

  test("a major on any lockstep package that releases the SDK as a major fails", () => {
    const failures = majorReleaseFailures(
      [
        changeset({ "@opengeni/contracts": "major" }, "Drop a response field."),
        changeset({ "@opengeni/runtime": "major" }),
        changeset({ "@opengeni/sdk": "minor" }),
      ],
      lockstepMajor,
    );
    expect(failures).toHaveLength(2);
    expect(failures[0]).toContain(
      "declares a major release of @opengeni/contracts, which releases @opengeni/react and @opengeni/sdk as a major",
    );
  });

  test("a propagated major that no changeset declares still fails", () => {
    expect(majorReleaseFailures([changeset({ "@opengeni/sdk": "patch" })], lockstepMajor)).toEqual([
      expect.stringContaining("although no changeset declares one"),
    ]);
  });

  test("minors and patches pass, even beside a non-public major outside the lockstep group", () => {
    expect(
      majorReleaseFailures(
        [changeset({ "@opengeni/sdk": "minor", "@opengeni/react": "patch" }), changeset({})],
        minorRelease,
      ),
    ).toEqual([]);
    expect(
      majorReleaseFailures(
        [changeset({ "@opengeni/internal-tool": "major" })],
        [...minorRelease, { name: "@opengeni/internal-tool", type: "major" }],
      ),
    ).toEqual([]);
  });

  test("an exception must link the repository or the exception log, outside code fences", () => {
    expect(compatibilityException(LINKED)).toBe(
      "docs/design/api-compatibility-policy.md#exception-log",
    );
    expect(
      compatibilityException(
        "Compatibility exception: https://github.com/Cloudgeni-ai/opengeni/pull/1#issuecomment-1",
      ),
    ).toBe("https://github.com/Cloudgeni-ai/opengeni/pull/1#issuecomment-1");
    expect(compatibilityException("Compatibility exception: https://example.com/ok")).toBe(
      undefined,
    );
    expect(compatibilityException("Compatibility exception: docs/anything.md")).toBe(undefined);
    expect(compatibilityException(`Example:\n\n\`\`\`md\n${LINKED}\n\`\`\`\n`)).toBe(undefined);
  });
});

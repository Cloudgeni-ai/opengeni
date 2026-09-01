import { describe, expect, test } from "bun:test";
import {
  FRAMEWORK_SESSION_REQUIRED_STATES,
  FRAMEWORK_SESSION_STATE_MANIFEST,
  FRAMEWORK_SESSION_VARIANTS,
  projectFrameworkSessionScript,
  validateFrameworkSessionManifest,
  type FrameworkSessionManifestRow,
} from "./fixtures/framework-session/state-manifest";

describe("framework session state manifest", () => {
  test("contains every binding state as a deterministic coverage specification", () => {
    expect(validateFrameworkSessionManifest()).toEqual([]);
    expect(FRAMEWORK_SESSION_STATE_MANIFEST).toHaveLength(
      Object.values(FRAMEWORK_SESSION_REQUIRED_STATES).flat().length,
    );
    expect(new Set(FRAMEWORK_SESSION_STATE_MANIFEST.map(({ id }) => id)).size).toBe(
      FRAMEWORK_SESSION_STATE_MANIFEST.length,
    );
  });

  test("projects every script deterministically and rejects stale-generation settlements", () => {
    for (const row of FRAMEWORK_SESSION_STATE_MANIFEST) {
      const first = projectFrameworkSessionScript(row);
      const second = projectFrameworkSessionScript(row);
      expect(first).toEqual(second);
      expect(first.finalResources).toEqual({
        readers: 0,
        streams: 0,
        listeners: 0,
        timers: 0,
        objectUrls: 0,
      });
      for (let index = 1; index < first.generations.length; index += 1) {
        expect(first.generations[index]!).toBeGreaterThanOrEqual(first.generations[index - 1]!);
      }
      if (row.script.steps.some(({ name }) => name.endsWith(":stale-completion"))) {
        expect(first.events).not.toContain(`${row.id}:stale-completion`);
      }
    }
  });

  test("the covering array assigns every responsive, theme, density, motion, input, and content case", () => {
    const assigned = new Set(
      FRAMEWORK_SESSION_STATE_MANIFEST.flatMap(({ variantIds }) => variantIds),
    );
    expect(assigned).toEqual(new Set(FRAMEWORK_SESSION_VARIANTS.map(({ id }) => id)));
  });

  test("fault probes prove the validator detects missing states, duplicate rows, placeholders, and cleanup leaks", () => {
    const first = FRAMEWORK_SESSION_STATE_MANIFEST[0]!;
    expect(validateFrameworkSessionManifest(FRAMEWORK_SESSION_STATE_MANIFEST.slice(1))).toContain(
      `missing required state id: ${first.id}`,
    );
    expect(
      validateFrameworkSessionManifest([...FRAMEWORK_SESSION_STATE_MANIFEST, first]),
    ).toContain(`duplicate state id: ${first.id}`);

    const placeholder = replaceRow(first, {
      references: { ...first.references, react: "TODO placeholder" },
    });
    expect(
      validateFrameworkSessionManifest([placeholder, ...FRAMEWORK_SESSION_STATE_MANIFEST.slice(1)]),
    ).toContain(`${first.id}: invalid react reference`);

    const leaked = replaceRow(first, {
      expected: {
        ...first.expected,
        teardown: { ...first.expected.teardown, timers: 1 as never },
      },
    });
    expect(
      validateFrameworkSessionManifest([leaked, ...FRAMEWORK_SESSION_STATE_MANIFEST.slice(1)]),
    ).toContain(`${first.id}: teardown does not return every resource to zero`);
  });
});

function replaceRow(
  row: FrameworkSessionManifestRow,
  patch: Partial<FrameworkSessionManifestRow>,
): FrameworkSessionManifestRow {
  return { ...row, ...patch };
}

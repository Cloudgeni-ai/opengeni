import { describe, expect, test } from "bun:test";

const styles = await Bun.file(`${import.meta.dir}/styles.css`).text();

describe("Northstar host typography", () => {
  test("limits the hostile font reset to embedded OpenGeni surfaces", () => {
    const resetSelectors = styles.match(/([^{}]+)\{\s*font:\s*inherit;\s*\}/)?.[1];
    expect(resetSelectors).toBeDefined();

    for (const control of ["button", "select", "input", "textarea"]) {
      expect(resetSelectors).toContain(`.northstar .og-root ${control}`);
      expect(resetSelectors).not.toMatch(new RegExp(`\\.northstar ${control}(?:,|$)`));
    }
  });
});

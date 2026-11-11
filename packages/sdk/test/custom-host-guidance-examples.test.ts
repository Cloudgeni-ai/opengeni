import { expect, test } from "bun:test";

const root = new URL("../../../", import.meta.url);

test("provider guidance retains negative host-endpoint authorization tests, not only tool allowlists", async () => {
  const primary = await Bun.file(new URL("docs-site/integrate/your-data.mdx", root)).text();
  expect(primary).toContain("ordinary host login JWT");
  expect(primary).toContain("separate signing key/token namespace");
  expect(primary).toContain("issuer/audience");
  expect(primary).toContain("account/password/admin APIs");
  expect(primary).toContain("ordinary host endpoints");
});

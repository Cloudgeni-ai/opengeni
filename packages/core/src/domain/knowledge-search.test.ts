import { afterAll, expect, mock, test } from "bun:test";
const list = mock(
  async (_db: unknown, _context: unknown, _request: unknown, _embedding?: unknown) => ({
    entries: [],
    nextCursor: null,
  }),
);
mock.module("@opengeni/db", () => ({ listKnowledgeEntries: list }));
const { searchKnowledgeEntries } = await import("./knowledge-search");
afterAll(() => mock.restore());
const unavailable = () => {
  throw new Error("embedding unavailable");
};
test("hybrid fallback keeps lexical recall and passes the exact scope and cursor", async () => {
  const result = await searchKnowledgeEntries(
    {} as never,
    {} as never,
    {
      query: "Acme renewal renew contract expiration renewal date",
      scope: "workspace",
      cursor: "page-2",
    },
    unavailable,
  );
  expect(result.searchMode).toBe("keyword");
  expect(list.mock.calls.at(-1)?.[2]).toMatchObject({
    query: '"Acme" OR "renewal" OR "renew" OR "contract" OR "expiration" OR "date"',
    mode: "keyword",
    scope: "workspace",
    cursor: "page-2",
  });
});
test("keyword and explicit search syntax remain unchanged", async () => {
  for (const query of ['"Acme renewal"', "Acme -expired", "Acme OR renewal"]) {
    await searchKnowledgeEntries({} as never, {} as never, { query }, unavailable);
    expect(list.mock.calls.at(-1)?.[2]).toMatchObject({ query });
  }
  await searchKnowledgeEntries(
    {} as never,
    {} as never,
    { query: "Acme renewal", mode: "keyword" },
    unavailable,
  );
  expect(list.mock.calls.at(-1)?.[2]).toMatchObject({ query: "Acme renewal", mode: "keyword" });
});

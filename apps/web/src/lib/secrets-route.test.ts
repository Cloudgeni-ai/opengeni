import { describe, expect, test } from "bun:test";

import { parseSecretsIndexSearch } from "./secrets-route";

const CONNECTION = "0b6d8b1e-3c5a-4f0e-9a51-6c2f1f0d7a10";

describe("parseSecretsIndexSearch", () => {
  test("keeps the list views", () => {
    expect(parseSecretsIndexSearch({ view: "new" })).toEqual({ view: "new" });
    expect(parseSecretsIndexSearch({ view: "connect-1password" })).toEqual({
      view: "connect-1password",
    });
    expect(parseSecretsIndexSearch({ view: "nope" })).toEqual({});
  });

  test("keeps an owner only on Connect 1Password", () => {
    expect(parseSecretsIndexSearch({ view: "connect-1password", owner: "user" })).toEqual({
      view: "connect-1password",
      owner: "user",
    });
    expect(parseSecretsIndexSearch({ view: "connect-1password", owner: "task" })).toEqual({
      view: "connect-1password",
    });
    expect(parseSecretsIndexSearch({ view: "new", owner: "user" })).toEqual({ view: "new" });
  });

  test("opens a connection and its views", () => {
    expect(parseSecretsIndexSearch({ connection: CONNECTION })).toEqual({
      connection: CONNECTION,
    });
    expect(
      parseSecretsIndexSearch({ connection: CONNECTION.toUpperCase(), view: "replace-token" }),
    ).toEqual({ connection: CONNECTION, view: "replace-token" });
    expect(parseSecretsIndexSearch({ connection: CONNECTION, view: "new" })).toEqual({
      connection: CONNECTION,
    });
  });

  test("drops a connection that isn't an id", () => {
    expect(parseSecretsIndexSearch({ connection: "../vaults", view: "choose-vaults" })).toEqual({});
  });
});

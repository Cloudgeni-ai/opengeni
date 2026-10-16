import { describe, expect, test } from "bun:test";
import {
  ProjectionError,
  createBody,
  customFieldId,
  mergeUpdate,
  projectItem,
  protectedValuesVisible,
  readValues,
} from "../src/projection";
import { COLLECTION_ID, ORG_ID, login } from "./fake-bw-serve";

const SECRET_VALUES = [
  "hunter2",
  "ghp_secret",
  "octo",
  "recovery codes",
  "JBSWY3DPEHPK3PXP",
  "platform",
  "old",
];

describe("projectItem", () => {
  test("carries names, kinds, websites and version but never values", () => {
    const item = login();
    const meta = projectItem(item);
    const text = JSON.stringify(meta);
    for (const value of SECRET_VALUES) expect(text).not.toContain(value);
    expect(meta).toMatchObject({
      externalItemId: item.id,
      name: "GitHub",
      type: "login",
      websites: ["https://github.com"],
      version: "2026-10-15T10:00:00.000Z",
    });
    expect(meta.fields).toEqual([
      { externalFieldId: "login.username", name: "username", kind: "text" },
      { externalFieldId: "login.password", name: "password", kind: "concealed" },
      { externalFieldId: "login.totp", name: "totp", kind: "totp" },
      { externalFieldId: "notes", name: "note", kind: "text" },
      { externalFieldId: customFieldId("api key", 0), name: "api key", kind: "concealed" },
      { externalFieldId: customFieldId("team", 0), name: "team", kind: "text" },
    ]);
  });

  test("omits redacted, linked and malformed TOTP fields", () => {
    const item = login({
      login: { uris: [], username: "octo", password: null, totp: "not a seed!!" },
      fields: [
        { name: "api key", value: null, type: 1, linkedId: null },
        { name: "linked", value: null, type: 3, linkedId: 100 },
      ],
    });
    expect(projectItem(item).fields.map((field) => field.externalFieldId)).toEqual([
      "login.username",
      "notes",
    ]);
  });

  test("custom field ids are stable per name and occurrence, not value", () => {
    const a = login({
      fields: [
        { name: "pin", value: "1", type: 1 },
        { name: "pin", value: "2", type: 1 },
      ],
    });
    const b = login({
      fields: [
        { name: "pin", value: "9", type: 1 },
        { name: "pin", value: "8", type: 1 },
      ],
    });
    expect(projectItem(a).fields.map((f) => f.externalFieldId)).toEqual(
      projectItem(b).fields.map((f) => f.externalFieldId),
    );
    expect(projectItem(a).fields.map((f) => f.name)).toContain("pin (2)");
  });
});

describe("readValues", () => {
  test("returns exactly the requested values", () => {
    const item = login();
    expect(readValues(item, ["login.password", "login.totp", customFieldId("api key", 0)])).toEqual(
      [
        { externalFieldId: "login.password", value: { type: "text", value: "hunter2" } },
        { externalFieldId: "login.totp", value: { type: "totp", value: "JBSWY3DPEHPK3PXP" } },
        {
          externalFieldId: customFieldId("api key", 0),
          value: { type: "text", value: "ghp_secret" },
        },
      ],
    );
  });

  test("a value hidden by Bitwarden is permission denied; an unknown id is not found", () => {
    const item = login({
      login: { uris: [], username: "octo", password: null, totp: null },
      fields: [{ name: "api key", value: null, type: 1, linkedId: null }],
    });
    for (const id of ["login.password", "login.totp", customFieldId("api key", 0)]) {
      expect(() => readValues(item, [id])).toThrow(
        expect.objectContaining({ reason: "permission_denied" }),
      );
    }
    expect(() => readValues(item, ["field:unknown:0"])).toThrow(
      expect.objectContaining({ reason: "not_found" }),
    );
  });
});

describe("mergeUpdate", () => {
  test("sends the whole current item with unknown properties and the revision precondition", () => {
    const item = login();
    const body = mergeUpdate(item, {
      externalItemId: item.id,
      name: "GitHub (work)",
      type: "login",
      websites: ["https://github.com", "https://gist.github.com"],
      fields: [
        {
          externalFieldId: "login.password",
          name: "password",
          kind: "concealed",
          value: "new-pass",
        },
        { externalFieldId: customFieldId("team", 0), name: "team", kind: "text", remove: true },
        { name: "region", kind: "text", value: "eu" },
      ],
    });
    expect(body.revisionDate).toBe(item.revisionDate);
    expect(body.unknownFutureField).toEqual({ keep: true });
    expect(body.passwordHistory).toEqual(item.passwordHistory);
    expect(body.name).toBe("GitHub (work)");
    const bodyLogin = body.login as Record<string, unknown>;
    expect(bodyLogin.password).toBe("new-pass");
    expect(bodyLogin.username).toBe("octo");
    expect(bodyLogin.fido2Credentials).toEqual([]);
    expect(bodyLogin.uris).toEqual([
      { match: 3, uri: "https://github.com", uriChecksum: "abc" },
      { uri: "https://gist.github.com", match: null },
    ]);
    expect(body.fields).toEqual([
      { name: "api key", value: "ghp_secret", type: 1, linkedId: null },
      { name: "linked", value: null, type: 3, linkedId: 100 },
      { name: "region", value: "eu", type: 0, linkedId: null },
    ]);
    // The source item is untouched.
    expect((item.login as Record<string, unknown>).password).toBe("hunter2");
  });

  test("refuses redacted or linked fields, type changes and duplicate names", () => {
    const redacted = login({ fields: [{ name: "api key", value: null, type: 1, linkedId: null }] });
    const base = { externalItemId: redacted.id, name: "x", type: "login" as const, websites: [] };
    expect(() =>
      mergeUpdate(redacted, {
        ...base,
        fields: [
          {
            externalFieldId: customFieldId("api key", 0),
            name: "api key",
            kind: "concealed",
            value: "x",
          },
        ],
      }),
    ).toThrow(expect.objectContaining({ reason: "permission_denied" }));
    expect(() => mergeUpdate(redacted, { ...base, type: "note", fields: [] })).toThrow(
      ProjectionError,
    );
    expect(() =>
      mergeUpdate(login(), { ...base, fields: [{ name: "username", kind: "text", value: "dup" }] }),
    ).toThrow(expect.objectContaining({ reason: "conflict" }));
    expect(() =>
      mergeUpdate(login(), {
        ...base,
        fields: [
          { externalFieldId: "login.totp", name: "totp", kind: "totp", value: "not a seed!!" },
        ],
      }),
    ).toThrow(expect.objectContaining({ reason: "unsupported" }));
  });

  test("unchanged websites keep every raw URI, including ones the projection omits", () => {
    const uris = Array.from({ length: 25 }, (_, index) => ({
      uri: `https://h${index}.example.com`,
      match: null,
    }));
    uris.push({ uri: "https://bad.example.com/\u0007", match: null });
    const item = login({ login: { uris, username: "octo", password: "p", totp: null } });
    const meta = projectItem(item);
    expect(meta.websites).toHaveLength(20);
    const body = mergeUpdate(item, {
      externalItemId: item.id,
      name: "renamed",
      type: "login",
      websites: meta.websites,
      fields: [],
    });
    expect((body.login as Record<string, unknown>).uris).toEqual(uris);
  });
});

describe("redacted values", () => {
  const redacted = () =>
    login({
      organizationId: ORG_ID,
      collectionIds: [COLLECTION_ID],
      passwordHistory: undefined,
      login: {
        uris: [{ uri: "https://github.com", match: null }],
        username: "octo",
        password: null,
        totp: null,
      },
      fields: [
        { name: "api key", value: null, type: 1, linkedId: null },
        { name: "team", value: "platform", type: 0, linkedId: null },
      ],
    });

  test("visibility needs proof for collection items; personal items are always visible", () => {
    expect(protectedValuesVisible(redacted())).toBe(false);
    expect(protectedValuesVisible({ ...redacted(), organizationId: null })).toBe(true);
    expect(protectedValuesVisible({ ...redacted(), passwordHistory: [] })).toBe(true);
    expect(
      protectedValuesVisible({
        ...redacted(),
        fields: [{ name: "api key", value: "v", type: 1, linkedId: null }],
      }),
    ).toBe(true);
    expect(
      protectedValuesVisible({
        ...redacted(),
        login: { uris: [], username: "octo", password: "p", totp: null },
      }),
    ).toBe(true);
  });

  test("untouched sections are omitted; changed sections with redacted nulls are refused", () => {
    const item = redacted();
    const base = {
      externalItemId: item.id,
      type: "login" as const,
      websites: ["https://github.com"],
    };
    const renamed = mergeUpdate(item, { ...base, name: "renamed", fields: [] });
    expect(renamed.name).toBe("renamed");
    expect(renamed).not.toHaveProperty("login");
    expect(renamed).not.toHaveProperty("fields");
    // Changing a text field rewrites the list holding the redacted hidden value.
    expect(() =>
      mergeUpdate(item, {
        ...base,
        name: "x",
        fields: [
          { externalFieldId: customFieldId("team", 0), name: "team", kind: "text", value: "infra" },
        ],
      }),
    ).toThrow(expect.objectContaining({ reason: "redacted" }));
    const notesOnly = mergeUpdate(
      { ...item, fields: [{ name: "team", value: "platform", type: 0, linkedId: null }] },
      {
        ...base,
        name: "x",
        fields: [
          { externalFieldId: customFieldId("team", 0), name: "team", kind: "text", value: "infra" },
        ],
      },
    );
    expect(notesOnly).not.toHaveProperty("login");
    expect(notesOnly.fields).toEqual([{ name: "team", value: "infra", type: 0, linkedId: null }]);
    for (const fields of [
      [{ externalFieldId: "login.username", name: "username", kind: "text" as const, value: "x" }],
      [
        {
          externalFieldId: "login.password",
          name: "password",
          kind: "concealed" as const,
          remove: true as const,
        },
      ],
      [
        {
          externalFieldId: "login.password",
          name: "password",
          kind: "concealed" as const,
          value: "only-password",
        },
      ],
    ]) {
      expect(() => mergeUpdate(item, { ...base, name: "x", fields })).toThrow(
        expect.objectContaining({ reason: "redacted" }),
      );
    }
    expect(() =>
      mergeUpdate(item, {
        ...base,
        name: "x",
        websites: ["https://other.example.com"],
        fields: [],
      }),
    ).toThrow(expect.objectContaining({ reason: "redacted" }));
    const both = mergeUpdate(item, {
      ...base,
      name: "x",
      fields: [
        { externalFieldId: "login.password", name: "password", kind: "concealed", value: "p2" },
        { externalFieldId: "login.totp", name: "totp", kind: "totp", value: "GEZDGNBVGY3TQOJQ" },
      ],
    });
    expect(both.login).toMatchObject({
      username: "octo",
      password: "p2",
      totp: "GEZDGNBVGY3TQOJQ",
    });
    expect(both).not.toHaveProperty("fields");
  });
});

describe("createBody", () => {
  test("maps login fields and places the item in the configured collection", () => {
    const body = createBody(
      {
        name: "Stripe",
        type: "login",
        websites: ["https://dashboard.stripe.com"],
        fields: [
          { name: "username", kind: "text", value: "ops" },
          { name: "password", kind: "concealed", value: "pw" },
          { name: "totp", kind: "totp", value: "JBSWY3DPEHPK3PXP" },
          { name: "note", kind: "text", value: "n" },
          { name: "api key", kind: "concealed", value: "k" },
        ],
      },
      { organizationId: ORG_ID, collectionId: COLLECTION_ID },
    );
    expect(body).toMatchObject({
      type: 1,
      name: "Stripe",
      notes: "n",
      organizationId: ORG_ID,
      collectionIds: [COLLECTION_ID],
      login: { username: "ops", password: "pw", totp: "JBSWY3DPEHPK3PXP" },
      fields: [{ name: "api key", value: "k", type: 1, linkedId: null }],
    });
  });

  test("a secure note cannot carry websites; files and passkeys are refused", () => {
    expect(() =>
      createBody(
        { name: "n", type: "note", websites: ["https://x"], fields: [] },
        { organizationId: null, collectionId: null },
      ),
    ).toThrow(ProjectionError);
    expect(() =>
      createBody(
        { name: "n", type: "file", websites: [], fields: [] },
        { organizationId: null, collectionId: null },
      ),
    ).toThrow(ProjectionError);
    expect(
      createBody(
        { name: "n", type: "note", websites: [], fields: [] },
        { organizationId: null, collectionId: null },
      ),
    ).toMatchObject({
      type: 2,
      secureNote: { type: 0 },
      organizationId: null,
      collectionIds: [],
    });
  });
});

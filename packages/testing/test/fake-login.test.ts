import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  base32Decode,
  base32Encode,
  decodeCbor,
  hashPrefix,
  otpauthUri,
  passwordProblems,
  startFakeLoginServer,
  totp,
  verifyTotp,
  withFakeMailMcp,
  type FakeLoginServer,
} from "../src/fake-login";

const ascii = (text: string) => base32Encode(new TextEncoder().encode(text));

describe("fake-login TOTP oracle", () => {
  // RFC 6238 Appendix B (8 digits).
  const vectors: [number, string, string, string][] = [
    [59, "94287082", "46119246", "90693936"],
    [1111111109, "07081804", "68084774", "25091201"],
    [1111111111, "14050471", "67062674", "99943326"],
    [1234567890, "89005924", "91819424", "93441116"],
    [2000000000, "69279037", "90698825", "38618901"],
    [20000000000, "65353130", "77737706", "47863826"],
  ];
  const sha1 = ascii("12345678901234567890");
  const sha256 = ascii("12345678901234567890123456789012");
  const sha512 = ascii("1234567890123456789012345678901234567890123456789012345678901234");

  for (const [seconds, one, two, five] of vectors) {
    test(`RFC 6238 vector at ${seconds}`, () => {
      expect(totp(sha1, seconds * 1000, { digits: 8 })).toBe(one);
      expect(totp(sha256, seconds * 1000, { digits: 8, algorithm: "SHA256" })).toBe(two);
      expect(totp(sha512, seconds * 1000, { digits: 8, algorithm: "SHA512" })).toBe(five);
    });
  }

  test("base32 round trip and drift window", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(20));
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    expect(base32Decode("JBSWY3DPEHPK3PXP")).toEqual(
      Uint8Array.from([72, 101, 108, 108, 111, 33, 0xde, 0xad, 0xbe, 0xef]),
    );
    const now = 1_760_000_000_000;
    const previous = totp("JBSWY3DPEHPK3PXP", now - 30_000);
    expect(verifyTotp("JBSWY3DPEHPK3PXP", previous, now)).toBe(true);
    expect(verifyTotp("JBSWY3DPEHPK3PXP", totp("JBSWY3DPEHPK3PXP", now - 90_000), now)).toBe(false);
    expect(otpauthUri({ issuer: "Fake Login", account: "a b", secret: "ABC" })).toBe(
      "otpauth://totp/Fake%20Login:a%20b?secret=ABC&issuer=Fake+Login&algorithm=SHA1&digits=6&period=30",
    );
  });
});

describe("fake-login CBOR and password rules", () => {
  test("decodes the CBOR shapes WebAuthn uses", () => {
    // {"fmt": "none", "attStmt": {}, "n": -7, "b": h'0102', "a": [1, true, null]}
    const bytes = Uint8Array.from([
      0xa5, 0x63, 0x66, 0x6d, 0x74, 0x64, 0x6e, 0x6f, 0x6e, 0x65, 0x67, 0x61, 0x74, 0x74, 0x53,
      0x74, 0x6d, 0x74, 0xa0, 0x61, 0x6e, 0x26, 0x61, 0x62, 0x42, 0x01, 0x02, 0x61, 0x61, 0x83,
      0x01, 0xf5, 0xf6,
    ]);
    const value = decodeCbor(bytes) as Map<unknown, unknown>;
    expect(value.get("fmt")).toBe("none");
    expect(value.get("attStmt")).toEqual(new Map());
    expect(value.get("n")).toBe(-7);
    expect(value.get("b")).toEqual(Uint8Array.from([1, 2]));
    expect(value.get("a")).toEqual([1, true, null]);
    expect(() => decodeCbor(Uint8Array.from([0x01, 0x02]))).toThrow("trailing");
  });

  test("signup rules", () => {
    expect(passwordProblems("Gx7-kP2.qR9:mZ4=wT6?")).toEqual([]);
    expect(passwordProblems("short")).toEqual([
      "Use at least 16 characters.",
      "Include an uppercase letter.",
      "Include a digit.",
      "Include a symbol from !#%+-.:=?@_",
    ]);
    expect(passwordProblems("Abcdefghijklmn0!$ ")).toEqual([
      "These characters are not allowed: $  ",
    ]);
  });
});

describe("fake-login server over HTTP", () => {
  let server: FakeLoginServer;
  const lines: string[] = [];
  beforeAll(async () => {
    server = await startFakeLoginServer({ log: (line) => lines.push(line) });
  });
  afterAll(async () => {
    await server.close();
  });

  const post = (path: string, fields: Record<string, string>, cookie?: string) =>
    fetch(`${server.url}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: cookie ? { cookie } : {},
      body: new URLSearchParams(fields),
    });

  test("password login sets a session, records the exact value in memory and only hashes elsewhere", async () => {
    const bad = await post("/password", { username: "alice", password: "nope" });
    expect(bad.status).toBe(401);
    const good = await post("/password", {
      username: "alice",
      password: "Fake-Login-Alice-Password-1",
    });
    expect(good.status).toBe(303);
    const cookie = good.headers.get("set-cookie")!.split(";")[0]!;
    const whoami = await (await fetch(`${server.url}/whoami`, { headers: { cookie } })).json();
    expect(whoami).toEqual({ loggedIn: true, username: "alice", flow: "password" });
    expect(server.received().map((entry) => entry.value)).toContain("Fake-Login-Alice-Password-1");
    const state = await (await fetch(`${server.url}/state`)).text();
    expect(state).not.toContain("Fake-Login-Alice-Password-1");
    expect(state).toContain(hashPrefix("Fake-Login-Alice-Password-1"));
    expect(lines.join("\n")).not.toContain("Fake-Login-Alice-Password-1");
  });

  test("five failures lock the account", async () => {
    server.reset();
    for (let index = 0; index < 5; index += 1)
      await post("/password", { username: "alice", password: "x" });
    const locked = await post("/password", {
      username: "alice",
      password: "Fake-Login-Alice-Password-1",
    });
    expect(locked.status).toBe(401);
    expect(await locked.text()).toContain("Too many attempts");
    server.reset();
  });

  test("email code goes to the mailbox and its MCP surface", async () => {
    const sent = await post("/email-code", { email: "alice@fake-login.test" });
    expect(sent.status).toBe(303);
    const pending = sent.headers.get("set-cookie")!.split(";")[0]!;
    const code = await withFakeMailMcp(server.mcpUrl, async (mail) => {
      const [message] = await mail.search({ to: "alice@fake-login.test" });
      return /code is (\d{6})/u.exec((await mail.get(message!.id)).body)![1]!;
    });
    const verified = await post("/email-code/verify", { code }, pending);
    expect(verified.status).toBe(303);
    expect(server.state().successes.at(-1)).toMatchObject({
      flow: "email-code",
      username: "alice",
    });
  });

  test("TOTP login requires the code after the password", async () => {
    const first = await post("/totp/login", {
      username: "totp-user",
      password: "Fake-Login-Totp-Password-2",
    });
    expect(first.headers.get("location")).toBe("/totp/login/code");
    const pending = first.headers.get("set-cookie")!.split(";")[0]!;
    expect(
      (
        await post(
          "/totp/login/code",
          { code: "000000" === totp("JBSWY3DPEHPK3PXP", Date.now()) ? "111111" : "000000" },
          pending,
        )
      ).status,
    ).toBe(401);
    const ok = await post(
      "/totp/login/code",
      { code: totp("JBSWY3DPEHPK3PXP", Date.now()) },
      pending,
    );
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe("/welcome");
  });
});

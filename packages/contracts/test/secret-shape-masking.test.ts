/**
 * Shape-based secret masking (docs/secrets.md, Masking): high-precision
 * detectors mask only the secret part, never ordinary identifiers, and the
 * attempt memory captures what they find so a reference replaces it.
 * Every value here is fake and assembled at runtime.
 */
import { describe, expect, test } from "bun:test";
import {
  collectSecretShapes,
  detectSecretShapes,
  maskSecretShapes,
  maskSecretShapesInText,
  SecretValueMemory,
  type SecretShapeMatch,
} from "../src/index";

const REF_OPEN = "\u007B\u007Bsecret:";
const ref = (path: string) => `${REF_OPEN}${path}}}`;
const FAKE_PASSWORD = "FAKE-pw-0000-not-real";
const repeat = (unit: string, times: number) => unit.repeat(times);

function kinds(text: string) {
  return detectSecretShapes(text).map((match) => [match.kind, match.value]);
}

describe("URL passwords", () => {
  test("incident 1: only the password of a database URL is masked", () => {
    const line = `OPENGENI_DATABASE_URL=postgres://user:${FAKE_PASSWORD}@host:5432/db?sslmode=require`;
    expect(maskSecretShapesInText(line)).toBe(
      "OPENGENI_DATABASE_URL=postgres://user:[masked url password]@host:5432/db?sslmode=require",
    );
    const [match] = detectSecretShapes(line);
    expect(match?.username).toBe("user");
  });

  test("any scheme, empty users and unencoded @ in the password", () => {
    const schemes = [
      "postgresql",
      "mysql",
      "mongodb",
      "mongodb+srv",
      "redis",
      "rediss",
      "amqp",
      "amqps",
      "http",
      "https",
      "sftp",
    ];
    for (const scheme of schemes) {
      expect(kinds(`${scheme}://app:s3cret-Fake9@db.example.test/x`)).toEqual([
        ["url-password", "s3cret-Fake9"],
      ]);
    }
    expect(maskSecretShapesInText("redis://:fakePass99@cache:6379/0")).toBe(
      "redis://:[masked url password]@cache:6379/0",
    );
    expect(kinds("postgres://u:p@ss-Fake1@host/db")).toEqual([["url-password", "p@ss-Fake1"]]);
    // Short passwords are masked here too: the shape, not the length, decides.
    expect(maskSecretShapesInText("mysql://root:pw1@h/db")).toBe(
      "mysql://root:[masked url password]@h/db",
    );
  });

  test("a URL with a reference in the password position is left as it is", () => {
    const masked = `postgres://user:${ref("Task/url-password-0123456789abcdef/password")}@host:5432/db`;
    expect(detectSecretShapes(masked)).toEqual([]);
    expect(maskSecretShapesInText(masked)).toBe(masked);
  });
});

describe("other shapes", () => {
  test("private key blocks, whole or clipped, plain or JSON-escaped", () => {
    const body = repeat("MIIFakeKeyMaterial0123456789abcdefABCDEF+/", 4);
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${body}\n${body}\n-----END RSA PRIVATE KEY-----`;
    expect(maskSecretShapesInText(`key:\n${pem}\ndone`)).toBe("key:\n[masked private key]\ndone");
    const escaped = JSON.stringify({ private_key: `${pem}\n` });
    expect(maskSecretShapesInText(escaped)).toBe('{"private_key":"[masked private key]\\n"}');
    const clipped = `-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n${body.slice(0, 20)}`;
    expect(maskSecretShapesInText(`${clipped}\n`)).toBe("[masked private key]\n");
    // A public key or certificate is not a secret.
    const cert = `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`;
    expect(detectSecretShapes(cert)).toEqual([]);
  });

  test("well-known token formats", () => {
    const cases: Array<[string, string]> = [
      ["github-token", `ghp_${repeat("Ab1", 12)}`],
      ["github-token", `gho_${repeat("Ab1", 12)}`],
      ["github-token", `ghs_${repeat("Ab1", 12)}`],
      ["github-token", `github_pat_${repeat("Ab1_", 10)}`],
      ["openai-key", `sk-${repeat("Ab1", 16)}`],
      ["openai-key", `sk-proj-${repeat("Ab1-", 10)}`],
      ["anthropic-key", `sk-ant-api03-${repeat("Ab1_", 10)}`],
      ["slack-token", `xoxb-1234567890-${repeat("Ab1", 6)}`],
      ["stripe-key", `sk_live_${repeat("Ab1", 10)}`],
      ["stripe-key", `rk_test_${repeat("Ab1", 10)}`],
      ["npm-token", `npm_${repeat("Ab1", 12)}`],
      ["gitlab-token", `glpat-${repeat("Ab1", 8)}`],
      ["google-api-key", `AIza${repeat("Ab1_-", 7)}`],
      ["opengeni-token", `ogk_${repeat("ab12", 8)}`],
      ["opengeni-token", `oge_${repeat("Ab1", 8)}.${repeat("Xy9", 8)}`],
      ["opengeni-token", `ogs_${repeat("Ab1", 8)}.${repeat("Xy9", 8)}`],
      ["jwt", `eyJ${repeat("hbGciOi", 2)}.eyJ${repeat("zdWIiOi", 3)}.${repeat("SflKxwRJ0", 3)}`],
    ];
    for (const [kind, token] of cases) {
      expect(kinds(`token: "${token}" ok`)).toEqual([[kind, token]]);
    }
  });

  test("Azure keys and SAS signatures, and passwords in connection strings", () => {
    const key = `${repeat("AbCd0123", 8)}==`;
    expect(
      maskSecretShapesInText(
        `DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=${key};EndpointSuffix=core.windows.net`,
      ),
    ).toBe(
      "DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=[masked azure account key];EndpointSuffix=core.windows.net",
    );
    expect(
      maskSecretShapesInText(
        `Endpoint=sb://ns.servicebus.windows.net/;SharedAccessKeyName=Root;SharedAccessKey=${key}`,
      ),
    ).toBe(
      "Endpoint=sb://ns.servicebus.windows.net/;SharedAccessKeyName=Root;SharedAccessKey=[masked azure shared access key]",
    );
    expect(
      maskSecretShapesInText(
        "https://acct.blob.core.windows.net/c/f?sv=2022-11-02&se=2026-10-27&sig=AbCd0123AbCd0123%2BXyZ%3D",
      ),
    ).toBe(
      "https://acct.blob.core.windows.net/c/f?sv=2022-11-02&se=2026-10-27&sig=[masked azure sas signature]",
    );
    expect(
      maskSecretShapesInText("Server=db;Database=app;User Id=app;Password=Fake-pw-1;Encrypt=true"),
    ).toBe(
      "Server=db;Database=app;User Id=app;Password=[masked connection string password];Encrypt=true",
    );
    expect(maskSecretShapesInText("Driver={x};Uid=app;Pwd={Fake;pw1};")).toBe(
      "Driver={x};Uid=app;Pwd={[masked connection string password]};",
    );
    expect(maskSecretShapesInText("host=db user=app password=fakepw1 dbname=x")).toBe(
      "host=db user=app password=[masked connection string password] dbname=x",
    );
    expect(maskSecretShapesInText("jdbc:mysql://db/app?user=app&password=fakepw1")).toBe(
      "jdbc:mysql://db/app?user=app&password=[masked connection string password]",
    );
  });
});

describe("false-positive controls", () => {
  test("ordinary identifiers, data and prose stay untouched", () => {
    const texts = [
      "session 6001e019-2b4c-4d5e-8f9a-0b1c2d3e4f5a finished",
      "commit 47341de9e8a1b2c3d4e5f60718293a4b5c6d7e8f on main",
      `blob ${repeat("QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0123456789", 4)}==`,
      "password: required",
      "Password is required; please set one",
      "set password=true to enable",
      "https://example.test/path?query=1#frag",
      "postgres://user@host:5432/db",
      "git clone https://github.com/Cloudgeni-ai/opengeni.git",
      "http://localhost:8080/health",
      `postgres://user:\${DB_PASSWORD}@host/db`,
      "postgres://user:<password>@host/db",
      "postgres://user:****@host/db",
      "mysql://root:password@localhost/test",
      "task-runner sk-learn-tutorials desk-lamp",
      "ghp_short token-like words ogk_word",
      "AccountKey=<your key>",
    ];
    for (const text of texts) expect([text, maskSecretShapesInText(text)]).toEqual([text, text]);
  });
});

describe("deep masking and idempotency", () => {
  test("nested values, binary payloads and repeated masking", () => {
    const value = {
      text: `url postgres://u:${FAKE_PASSWORD}@h/db`,
      list: [`ghp_${repeat("Ab1", 12)}`],
      image: { mimeType: "image/png", data: `ghp_${repeat("Ab1", 12)}` },
    };
    const masked = maskSecretShapes(value);
    expect(masked.text).toBe("url postgres://u:[masked url password]@h/db");
    expect(masked.list).toEqual(["[masked github token]"]);
    expect(masked.image).toBe(value.image);
    expect(maskSecretShapes(masked)).toBe(masked);
    expect(collectSecretShapes(value).map((match) => match.kind)).toEqual([
      "url-password",
      "github-token",
    ]);
  });
});

describe("attempt memory capture", () => {
  const output = `OPENGENI_DATABASE_URL=postgres://user:${FAKE_PASSWORD}@host:5432/db?sslmode=require`;
  const reference = ref("Task/url-password-0123456789abcdef/password");

  test("a captured value is replaced by its reference everywhere afterwards", async () => {
    const memory = new SecretValueMemory();
    const seen: SecretShapeMatch[] = [];
    memory.setShapeCapturer(async (matches) => {
      seen.push(...matches);
      return new Map(matches.map((match) => [match.value, reference]));
    });
    await memory.captureShapes(output);
    expect(seen.map((match) => [match.kind, match.username])).toEqual([["url-password", "user"]]);
    expect(memory.maskToolOutput(output)).toBe(
      `OPENGENI_DATABASE_URL=postgres://user:${reference}@host:5432/db?sslmode=require`,
    );
    // Known from now on: masked in any text, also where no shape rule applies.
    expect(memory.mask(`echo ${FAKE_PASSWORD}`)).toBe(`echo ${reference}`);
    // Found again: not captured twice.
    await memory.captureShapes(output);
    expect(seen).toHaveLength(1);
  });

  test("without a capturer, or when capture fails, the marker is written", async () => {
    const plain = new SecretValueMemory();
    await plain.captureShapes(output);
    expect(plain.maskToolOutput(output)).toContain("user:[masked url password]@host");
    expect(plain.mask(`echo ${FAKE_PASSWORD}`)).toBe("echo [masked url password]");

    const failing = new SecretValueMemory();
    failing.setShapeCapturer(async () => {
      throw new Error("vault limit");
    });
    await failing.captureShapes(output);
    expect(failing.maskToolOutput(output)).toContain("user:[masked url password]@host");
  });

  test("a slow capture writes the marker now and the reference once it lands", async () => {
    const memory = new SecretValueMemory();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    memory.setShapeCapturer(async (matches) => {
      await gate;
      return new Map(matches.map((match) => [match.value, reference]));
    });
    await memory.captureShapes(output, "tool_result", 10);
    expect(memory.maskToolOutput(output)).toContain("user:[masked url password]@host");
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(memory.maskToolOutput(output)).toContain(`user:${reference}@host`);
  });

  test("tool output masking never throws", () => {
    const memory = new SecretValueMemory();
    const cyclic: Record<string, unknown> = { text: output };
    cyclic.self = cyclic;
    expect(() => memory.maskToolOutput(cyclic)).not.toThrow();
  });

  test("a value secret_get revealed stays readable, and an ended attempt captures nothing", async () => {
    const revealed = new SecretValueMemory();
    const captured: SecretShapeMatch[] = [];
    revealed.setShapeCapturer(async (matches) => {
      captured.push(...matches);
      return new Map(matches.map((match) => [match.value, reference]));
    });
    revealed.reveal(FAKE_PASSWORD);
    await revealed.captureShapes(output);
    expect(captured).toEqual([]);
    expect(revealed.maskToolOutput(output)).toBe(output);

    const ended = new SecretValueMemory();
    ended.setShapeCapturer(async (matches) => {
      captured.push(...matches);
      return new Map(matches.map((match) => [match.value, reference]));
    });
    ended.dispose();
    await ended.captureShapes(output);
    expect(captured).toEqual([]);
    expect(ended.mask(`echo ${FAKE_PASSWORD}`)).toBe(`echo ${FAKE_PASSWORD}`);
  });

  test("server-sent event lines are masked; only real data URLs are skipped", () => {
    const sse = `data: {"url":"postgres://user:${FAKE_PASSWORD}@host/db"}`;
    expect(maskSecretShapes({ text: sse })).toEqual({
      text: 'data: {"url":"postgres://user:[masked url password]@host/db"}',
    });
    const dataUrl = `data:image/png;base64,${Buffer.from(output).toString("base64")}`;
    expect(maskSecretShapes({ text: dataUrl })).toEqual({ text: dataUrl });
    // A text-type payload is masked decoded and stays valid base64.
    const url = `postgres://user:${FAKE_PASSWORD}@host/db`;
    const textUrl = `data:text/plain;base64,${Buffer.from(url).toString("base64")}`;
    const masked = maskSecretShapes({ text: textUrl }).text;
    const decoded = Buffer.from(masked.slice(masked.indexOf(",") + 1), "base64").toString();
    expect(decoded).toBe("postgres://user:[masked url password]@host/db");
  });
});

describe("review regressions", () => {
  const fakeBody = (lines: number) =>
    Array.from({ length: lines }, (_, index) => `FAKEkeyBODY${index}`.padEnd(64, "A")).join("\n");

  test("a weak or common password is masked where found but never searched everywhere", async () => {
    const memory = new SecretValueMemory();
    const url = "postgres://opengeni:opengeni@localhost:5432/opengeni";
    await memory.captureShapes(url);
    expect(memory.maskToolOutput(url)).toBe(
      "postgres://opengeni:[masked url password]@localhost:5432/opengeni",
    );
    expect(memory.mask("import from @opengeni/contracts")).toBe("import from @opengeni/contracts");
    expect(memory.maskToolOutput("cd /workspace/repos/opengeni")).toBe(
      "cd /workspace/repos/opengeni",
    );
  });

  test("a value secret_get revealed stays readable when it contains a shape", async () => {
    const memory = new SecretValueMemory();
    const captured: SecretShapeMatch[] = [];
    memory.setShapeCapturer(async (matches) => {
      captured.push(...matches);
      return new Map();
    });
    const databaseUrl = `postgres://app:${FAKE_PASSWORD}@db:5432/app`;
    const pem = `-----BEGIN PRIVATE KEY-----\n${fakeBody(4)}\n-----END PRIVATE KEY-----\n`;
    memory.reveal(databaseUrl);
    memory.reveal(pem);
    const result = JSON.stringify({ value: databaseUrl, encoding: "utf8", pem });
    await memory.captureShapes(result);
    expect(captured).toEqual([]);
    expect(memory.maskToolOutput(result)).toBe(result);
    // The same shapes outside the revealed values are still masked.
    expect(memory.maskToolOutput(`postgres://other:${FAKE_PASSWORD}x@db/app`)).toContain(
      "[masked url password]",
    );
  });

  test("source code and shell are not connection strings", () => {
    for (const line of [
      "const password = config.password; const host = env.HOST;",
      "if (password == null) throw new Error(); const host = x;",
      "password=$(cat /run/pw); host=db",
      "WHERE pwd = hash; SET x=1",
      "password=hunter22; retries=3",
    ]) {
      expect(kinds(line)).toEqual([]);
    }
  });

  test("connection strings: tight, quoted and braced passwords, and StorageAccountKey", () => {
    expect(kinds("Server=db;User Id=app;Password='FAKE pw 0000';")).toEqual([
      ["connection-string-password", "FAKE pw 0000"],
    ]);
    expect(kinds('host=db user=app password="FAKE-pw-0000"')).toEqual([
      ["connection-string-password", "FAKE-pw-0000"],
    ]);
    const key = `${repeat("FAKEkey0", 8)}==`;
    expect(kinds(`DefaultEndpointsProtocol=https;StorageAccountKey=${key};`)).toEqual([
      ["azure-account-key", key],
    ]);
    expect(kinds("AccountKey=your_account_key_here")).toEqual([]);
  });

  test("a URL inside JSON-escaped text", () => {
    expect(kinds(`{"url":"postgres:\\/\\/user:${FAKE_PASSWORD}@host\\/db"}`)).toEqual([
      ["url-password", FAKE_PASSWORD],
    ]);
  });

  test("the rest of a key whose BEGIN line was in an earlier chunk", () => {
    const tail = `${fakeBody(3)}\n-----END RSA PRIVATE KEY-----\nnext line`;
    expect(maskSecretShapesInText(tail)).toBe("[masked private key]\nnext line");
    const escaped = `"key":"${fakeBody(3).replaceAll("\n", "\\n")}\\n-----END PRIVATE KEY-----\\n"`;
    expect(maskSecretShapesInText(escaped)).toBe('"key":"[masked private key]\\n"');
    // Prose before the body is kept.
    expect(maskSecretShapesInText(`the rest:\n${tail}`)).toBe(
      "the rest:\n[masked private key]\nnext line",
    );
    expect(kinds("-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----")).toEqual([]);
  });

  test("identifiers that only share a token prefix", () => {
    for (const text of [
      "ogp_image_width_1200x630_default",
      "ogs_session_cache_v2_2024",
      "sk-cluster-2024-west-1a-prod-blue",
    ]) {
      expect(kinds(text)).toEqual([]);
    }
    const apiKey = `ogk_${repeat("0f", 32)}`;
    const envelope = `ogd_${repeat("eyFAKE0", 4)}.${repeat("sig0", 6)}`;
    const openai = `sk-proj-${repeat("FAKE0000", 6)}`;
    expect(kinds(`${apiKey} ${envelope} ${openai}`).map(([kind]) => kind)).toEqual([
      "opengeni-token",
      "opengeni-token",
      "openai-key",
    ]);
  });

  test("values beyond the per-result capture limit are captured from a later result", async () => {
    const memory = new SecretValueMemory();
    const seen: string[] = [];
    memory.setShapeCapturer(async (matches) => {
      seen.push(...matches.map((match) => match.value));
      return new Map(matches.map((match) => [match.value, ref(`Task/${match.value}/password`)]));
    });
    const urls = Array.from(
      { length: 20 },
      (_, index) => `postgres://u:FAKE-pw-${String(index).padStart(4, "0")}-x@h/db`,
    ).join("\n");
    await memory.captureShapes(urls);
    expect(seen).toHaveLength(16);
    await memory.captureShapes(urls);
    expect(seen).toHaveLength(20);
    expect(memory.maskToolOutput(urls)).not.toContain("[masked");
  });
});

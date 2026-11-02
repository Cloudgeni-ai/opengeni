import { describe, expect, test } from "bun:test";
import { redactPayload, redactSignedUrls } from "../src/timeline-model";

// Built from parts so no tool resolves them on the way into this file.
const ref = (path: string) => `{{${"secret"}:${path}}}`;

describe("secret references are never touched", () => {
  test.each([
    `gh auth login --with-token ${ref("GitHub/token")}`,
    `{"token": "${ref("Stripe/api_key")}"}`,
    `TOKEN=${ref("Ci/value")} ./x`,
    `git clone https://bob:${ref("Git/password")}@git.example.com/r.git`,
    `secret: ${ref("App/secret")}`,
    `curl -H "Authorization: Bearer ${ref("Api/token")}" https://api.example.com`,
  ])("%s", (text) => {
    expect(redactSignedUrls(text)).toBe(text);
    expect(redactSignedUrls(text, undefined, "text")).toBe(text);
  });
});

describe("printed text keeps code and prose readable", () => {
  test.each([
    "export function login(password: string) {",
    "if (token === undefined) return;",
    "const password = form.password.value;",
    "def login(user, password=None):",
    "Reset your password: open settings and choose a new one",
    "  password: string",
    "password: str = Field(min_length=8)",
    "password = hash_password(raw)",
    "password = sha256(raw)",
    "token: Optional[str] = None",
    '{"required": ["password", "username"]}',
    "secret: sauce",
    "the token: it expires hourly",
  ])("%s", (text) => {
    expect(redactSignedUrls(text, undefined, "text")).toBe(text);
  });

  test("a command that writes code keeps the code", () => {
    const command = [
      "cat > login.ts <<'EOF'",
      "export function login(password: string) {",
      "  if (token === undefined) return;",
      "  const password = form.password.value;",
      "}",
      "EOF",
    ].join("\n");
    expect(redactSignedUrls(command)).toBe(command);
  });
});

describe("credentials in more shapes are hidden", () => {
  test.each([
    ["text", "machine api.example.com login bob password hunter2pw", "hunter2pw"],
    ["text", "machine api.example.com\n  login bob\n  password hunter2pw", "hunter2pw"],
    ["command", 'curl -H "Cookie: session=abc123; theme=dark" https://x', "abc123"],
    ["text", "< Set-Cookie: sid=s3cr3tv; Path=/; HttpOnly", "s3cr3tv"],
    ["command", 'curl -H "Authorization: Bearer opensesame" https://x', "opensesame"],
    ["text", "Authorization: Bearer opensesame", "opensesame"],
    ["command", "mysql -u root -phunter2 db", "hunter2"],
    ["command", "docker login -u bob -p hunter2 registry.example.com", "hunter2"],
    ["command", "sshpass -p hunter2 ssh host", "hunter2"],
    ["command", "DB_PASS=hunter2 ./run", "hunter2"],
    ["text", "DB_PASSWORD=hunter", "hunter"],
    ["text", 'requests.get(url, auth=("bob", "hunter2"))', "hunter2"],
    ["command", 'headers: [["X-Api-Key", "opensesame"]]', "opensesame"],
    ["command", "api_key: opensesame", "opensesame"],
    ["text", "  api_key: opensesame", "opensesame"],
    ["text", "connecting as bob, password: hunter2pw", "hunter2pw"],
    ["text", "+ PASSWORD=hunter2pw ./migrate --password hunter2pw", "hunter2pw"],
    ["text", 'const password = "hunter";', "hunter"],
    [
      "text",
      "git clone https://ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8@github.com/o/r",
      "ghp_A1b2",
    ],
    ["text", "found ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8 in the log", "ghp_A1b2"],
    [
      "text",
      "key: -----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----",
      "MIIEow",
    ],
  ] as const)("%s: %s", (context, text, secret) => {
    const redacted = redactSignedUrls(text, undefined, context);
    expect(redacted).toContain("[hidden]");
    expect(redacted).not.toContain(secret);
  });

  test.each([
    "docker run -p 8080:80 nginx",
    "PWD=/home/me ./run",
    "ssh -p 2222 host",
    "mysql --password-file /etc/pw.cnf db",
  ])("ordinary commands stay as they are: %s", (text) => {
    expect(redactSignedUrls(text)).toBe(text);
  });
});

describe("payload views redact field by field", () => {
  test("a command field reads as a command and a patch as printed text", () => {
    const patch = "+const password = form.password.value;\n+if (token === undefined) {}";
    const shown = redactPayload({
      cmd: "DB_PASS=hunter2 mysql -phunter2 db",
      patch,
      headers: [["X-Api-Key", "opensesame"]],
    });
    expect(shown).toEqual({
      cmd: "DB_PASS=[hidden] mysql -p[hidden] db",
      patch,
      headers: [["X-Api-Key", "[hidden]"]],
    });
  });

  test("arguments given as JSON text are read field by field", () => {
    const shown = redactPayload(
      JSON.stringify({ cmd: "sshpass -p hunter2 ssh host", content: "password: string" }),
    );
    expect(JSON.parse(shown)).toEqual({
      cmd: "sshpass -p [hidden] ssh host",
      content: "password: string",
    });
  });
});

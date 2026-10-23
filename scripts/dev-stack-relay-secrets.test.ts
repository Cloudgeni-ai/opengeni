import { describe, expect, test } from "bun:test";

const source = await Bun.file(new URL("./dev-stack.sh", import.meta.url)).text();
// Execute the actual launcher block without starting infrastructure or generating credentials.
const start = source.indexOf("start_local_relay=0\n");
const end = source.indexOf("# A clean checkout must establish", start);
if (start < 0 || end < start) throw new Error("local relay launch block missing");
const configure = source.slice(start, end);

async function launch(environment: Record<string, string>) {
  const child = Bun.spawn(
    [
      "bash",
      "-eu",
      "-c",
      `${configure}\nnode -e 'process.stdout.write(JSON.stringify({viewer:process.env.OPENGENI_STREAM_TOKEN_SECRET,producer:process.env.OPENGENI_RELAY_TOKEN_SECRET}))'`,
    ],
    {
      env: {
        PATH: process.env.PATH,
        OPENGENI_SANDBOX_SELFHOSTED_ENABLED: "true",
        ...environment,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { status, stdout, stderr };
}

for (const explicitBind of [false, true]) {
  describe(`local relay signing keys (${explicitBind ? "explicit bind" : "loopback URL"})`, () => {
    const location = explicitBind
      ? {
          OPENGENI_SELFHOSTED_RELAY_URL: "wss://relay.example/stream",
          OPENGENI_RELAY_BIND: "0.0.0.0:8280",
        }
      : { OPENGENI_SELFHOSTED_RELAY_URL: "ws://127.0.0.1:8280/stream" };

    test("exports the delegation fallback for both producer and viewer", async () => {
      const result = await launch({
        ...location,
        OPENGENI_DELEGATION_SECRET: "fixture-delegation",
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        viewer: "fixture-delegation",
        producer: "fixture-delegation",
      });
    });

    test("preserves distinct explicit viewer and producer keys", async () => {
      const result = await launch({
        ...location,
        OPENGENI_DELEGATION_SECRET: "fixture-delegation",
        OPENGENI_STREAM_TOKEN_SECRET: "fixture-viewer",
        OPENGENI_SELFHOSTED_RELAY_TOKEN_SECRET: "fixture-producer",
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        viewer: "fixture-viewer",
        producer: "fixture-producer",
      });
    });

    test("an explicit producer key does not replace the viewer fallback", async () => {
      const result = await launch({
        ...location,
        OPENGENI_DELEGATION_SECRET: "fixture-delegation",
        OPENGENI_SELFHOSTED_RELAY_TOKEN_SECRET: "fixture-producer",
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        viewer: "fixture-delegation",
        producer: "fixture-producer",
      });
    });

    test("refuses to start without a viewer signing key", async () => {
      const result = await launch({
        ...location,
        OPENGENI_SELFHOSTED_RELAY_TOKEN_SECRET: "fixture-producer",
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("for viewers");
      expect(result.stdout).toBe("");
    });
  });
}

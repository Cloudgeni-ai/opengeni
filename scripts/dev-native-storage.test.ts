import { afterEach, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configureGarage,
  garagePlatform,
  garageReleases,
  garageVersion,
  provisionGarage,
  resolveFixture,
  signedRequest,
  storageSettings,
} from "./dev-native-storage";

const directories: string[] = [];
function temporary() {
  const path = mkdtempSync(join(tmpdir(), "opengeni-native-storage-test-"));
  directories.push(path);
  return path;
}
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("native provider selection", () => {
  test("fresh state defaults to Garage and permits explicit MinIO", () => {
    const state = temporary();
    expect(resolveFixture(state)).toBe("garage");
    expect(resolveFixture(state, "minio")).toBe("minio");
    expect(() => resolveFixture(state, "other")).toThrow("garage or minio");
  });
  test("legacy MinIO state is never silently switched, even when empty", () => {
    const state = temporary();
    mkdirSync(join(state, "minio"));
    expect(resolveFixture(state)).toBe("minio");
    expect(() => resolveFixture(state, "garage")).toThrow("refusing to switch");
  });
  test("persisted selection survives restarts and rejects ambiguous state", () => {
    const state = temporary();
    writeFileSync(join(state, "storage-provider"), "garage\n");
    expect(resolveFixture(state)).toBe("garage");
    expect(() => resolveFixture(state, "minio")).toThrow("refusing to switch");
    mkdirSync(join(state, "minio"));
    expect(() => resolveFixture(state)).toThrow("Conflicting");
  });
  test("legacy PID evidence and malformed markers fail safely", () => {
    const state = temporary();
    mkdirSync(join(state, "pids"));
    writeFileSync(join(state, "pids/minio.pid"), "123\n1\n");
    expect(resolveFixture(state)).toBe("minio");
    writeFileSync(join(state, "storage-provider"), "garbage\n");
    expect(() => resolveFixture(state)).toThrow("Invalid");
  });
});

test("bounded platform matrix and immutable Linux pins", () => {
  expect(garageVersion).toBe("2.3.0");
  for (const arch of ["x64", "arm64"] as const) {
    expect(garagePlatform("linux", arch)).toBe("binary");
    expect(garagePlatform("darwin", arch)).toBe("source");
    expect(garageReleases[arch].sha256).toMatch(/^[a-f0-9]{64}$/);
  }
  expect(() => garagePlatform("win32", "x64")).toThrow("WSL2");
  expect(() => garagePlatform("linux", "ia32")).toThrow("x64/arm64");
});

test("configuration isolates paths, binds loopback, and preserves the RPC secret", () => {
  const state = temporary();
  const settings = storageSettings({
    OPENGENI_GARAGE_HOST_PORT: "49100",
    OPENGENI_GARAGE_RPC_HOST_PORT: "49101",
  });
  const path = configureGarage(state, settings);
  const before = readFileSync(path, "utf8");
  configureGarage(state, settings);
  expect(readFileSync(path, "utf8")).toBe(before);
  expect(before).toContain('api_bind_addr = "127.0.0.1:49100"');
  expect(before).toContain('rpc_bind_addr = "127.0.0.1:49101"');
  expect(before).not.toContain("[::]");
  expect(before).toContain(join(state, "garage/meta"));
  expect(() => storageSettings({ OPENGENI_GARAGE_HOST_PORT: "3901" })).toThrow("distinct");
  expect(() => storageSettings({ OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID: "minioadmin" })).toThrow(
    "refusing to replace",
  );
});

// Opt-in real release smoke. No installed services, mc, checkout .env, or default ports.
test.skipIf(!process.env.OPENGENI_TEST_GARAGE_BINARY)(
  "real Garage: bucket/CORS, object persistence across restart",
  async () => {
    const state = temporary();
    const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const rpcListener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const settings = storageSettings({
      OPENGENI_GARAGE_HOST_PORT: String(listener.port),
      OPENGENI_GARAGE_RPC_HOST_PORT: String(rpcListener.port),
    });
    listener.stop(true);
    rpcListener.stop(true);
    const config = configureGarage(state, settings);
    const start = () =>
      Bun.spawn(
        [
          process.env.OPENGENI_TEST_GARAGE_BINARY!,
          "-c",
          config,
          "server",
          "--single-node",
          "--default-bucket",
        ],
        {
          env: {
            PATH: process.env.PATH,
            GARAGE_DEFAULT_ACCESS_KEY: settings.accessKey,
            GARAGE_DEFAULT_SECRET_KEY: settings.secretKey,
            GARAGE_DEFAULT_BUCKET: settings.bucket,
          },
          stdout: "ignore",
          stderr: "ignore",
        },
      );
    let child = start();
    const request = (method: string, suffix: string, body = "") => {
      const url = new URL(`http://127.0.0.1:${settings.port}/${settings.bucket}${suffix}`);
      return fetch(url, {
        method,
        headers: signedRequest(url, method, body, settings.accessKey, settings.secretKey),
        ...(method === "PUT" ? { body } : {}),
        signal: AbortSignal.timeout(3000),
      });
    };
    try {
      await provisionGarage(settings);
      await provisionGarage(settings);
      const cors = await request("GET", "?cors=");
      expect(cors.status).toBe(200);
      expect(await cors.text()).toContain("x-amz-meta-sha256");
      const put = await request("PUT", "/test-object", "preserved bytes");
      expect(put.status).toBe(200);
      await put.body?.cancel();
      child.kill("SIGTERM");
      await child.exited;
      child = start();
      await provisionGarage(settings);
      const get = await request("GET", "/test-object");
      expect(get.status).toBe(200);
      expect(await get.text()).toBe("preserved bytes");
      const preflight = await fetch(
        `http://127.0.0.1:${settings.port}/${settings.bucket}/test-object`,
        {
          method: "OPTIONS",
          headers: {
            origin: "http://localhost:3000",
            "access-control-request-method": "PUT",
            "access-control-request-headers": "content-type",
          },
        },
      );
      expect(preflight.status).toBe(200);
      expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
      await preflight.body?.cancel();
    } finally {
      child.kill("SIGTERM");
      await child.exited;
    }
  },
  60_000,
);

for (const provider of ["garage", "minio"] as const) {
  test.skipIf(provider === "garage" && !process.env.OPENGENI_TEST_GARAGE_BINARY)(
    `native shell lifecycle: ${provider}`,
    async () => {
      const root = temporary();
      const bin = join(root, "bin");
      mkdirSync(bin);
      mkdirSync(join(root, "scripts"));
      mkdirSync(join(root, "deploy/garage"), { recursive: true });
      for (const name of ["dev-native-infra.sh", "dev-native-storage.ts", "dev-stack-project.sh"])
        copyFileSync(new URL(name, import.meta.url), join(root, "scripts", name));
      copyFileSync(
        new URL("../deploy/garage/cors.xml", import.meta.url),
        join(root, "deploy/garage/cors.xml"),
      );
      const fixture = join(root, ".opengeni/native/lifecycle-test");
      const cache = join(
        fixture,
        "runtime",
        `garage-${garageVersion}-${process.platform}-${process.arch}`,
      );
      mkdirSync(cache, { recursive: true });
      if (provider === "garage")
        copyFileSync(process.env.OPENGENI_TEST_GARAGE_BINARY!, join(cache, "garage"));
      const command = (name: string, body: string) =>
        writeFileSync(join(bin, name), `#!/usr/bin/env bash\nset -eu\n${body}\n`, { mode: 0o755 });
      command("pg_config", 'printf "%s\\n" "$TEST_BIN"');
      command("id", 'if [ "${1:-}" = -u ]; then echo 1000; else /usr/bin/id "$@"; fi');
      command("initdb", 'mkdir -p "$2"; touch "$2/PG_VERSION"; echo 12345 > "$2/postmaster.pid"');
      command(
        "pg_ctl",
        'data="$2"; case "${*: -1}" in status) test -f "$data/running";; stop) rm -f "$data/running";; *) touch "$data/running";; esac',
      );
      for (const name of ["psql", "createdb", "pg_isready"]) command(name, "echo 1");
      // Tripwires: any dependency on mc/minio on the Garage path fails the test.
      for (const name of ["mc", "minio"])
        command(name, 'touch "$TEST_ROOT/forbidden-storage-command"; exit 91');
      if (provider === "minio") {
        command("minio", 'exec bun "$TEST_BIN/listen.ts" --port "$OPENGENI_MINIO_HOST_PORT"');
        command("mc", 'echo "mc provisioned" >> "$TEST_ROOT/mc-calls"');
      }
      writeFileSync(
        join(bin, "listen.ts"),
        'const i = process.argv.findIndex((v) => v === "-p" || v === "--port"); Bun.listen({ hostname: "127.0.0.1", port: Number(process.argv[i + 1]), socket: { data() {} } }); setInterval(() => {}, 1000);',
      );
      for (const name of ["nats-server", "temporal"])
        command(name, 'exec bun "$TEST_BIN/listen.ts" "$@"');
      const reserve = () => Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
      const listeners = Array.from({ length: 5 }, reserve);
      const ports = listeners.map((listener) => String(listener.port));
      // PostgreSQL is a TCP fixture only; its process lifecycle is mocked above.
      for (const listener of listeners.slice(1)) listener.stop(true);
      const env = {
        PATH: `${bin}:${process.env.PATH}`,
        TEST_BIN: bin,
        TEST_ROOT: root,
        COMPOSE_PROJECT_NAME: "lifecycle-test",
        OPENGENI_POSTGRES_HOST_PORT: ports[0]!,
        OPENGENI_NATS_HOST_PORT: ports[1]!,
        OPENGENI_TEMPORAL_HOST_PORT: ports[2]!,
        OPENGENI_GARAGE_HOST_PORT: ports[3]!,
        OPENGENI_GARAGE_RPC_HOST_PORT: ports[4]!,
        OPENGENI_MINIO_HOST_PORT: ports[3]!,
        ...(provider === "minio" ? { OPENGENI_OBJECT_STORAGE_FIXTURE: "minio" } : {}),
      };
      const invoke = async (...args: string[]) => {
        const child = Bun.spawn(["bash", "scripts/dev-native-infra.sh", ...args], {
          cwd: root,
          env,
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        if (code !== 0) throw new Error(`native ${args.join(" ")}: ${stdout}\n${stderr}`);
        return stdout;
      };
      try {
        expect(await invoke("up")).toContain(`${provider}-bucket=`);
        expect(await invoke("status")).toContain("is running");
        expect(await invoke("ps")).toContain(provider);
        await invoke("logs", provider);
        expect(existsSync(join(root, "forbidden-storage-command"))).toBe(false);
        expect(existsSync(join(fixture, "minio"))).toBe(provider === "minio");
        expect(existsSync(join(root, "mc-calls"))).toBe(provider === "minio");
        await invoke("down");
        expect(existsSync(join(fixture, provider))).toBe(true);
        expect(await invoke("up")).toContain(`${provider}-bucket=`);
        writeFileSync(join(root, "unrelated"), "keep");
        await invoke("clean");
        expect(existsSync(fixture)).toBe(false);
        expect(readFileSync(join(root, "unrelated"), "utf8")).toBe("keep");
      } finally {
        await invoke("down");
        listeners[0]!.stop(true);
      }
    },
    90_000,
  );
}

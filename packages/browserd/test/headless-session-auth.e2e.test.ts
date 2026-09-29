import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  stableJson,
  type BrowserObservation,
  type BrowserRevisionMaterialization,
  type InteractionSemanticNodeValue,
} from "@opengeni/contracts";
import {
  BrowserSupervisor,
  BROWSER_STATE_ARTIFACT_CONTENT_TYPE,
  type BrowserProfileManifest,
} from "../src";
import { resolvePinnedHeadlessShell } from "../src/headless-shell";

const e2e =
  process.env.OPENGENI_BROWSERD_E2E === "1" &&
  process.env.OPENGENI_BROWSERD_HEADLESS_SHELL_DIRECTORY
    ? test
    : test.skip;

e2e.each(["restart", "stop"] as const)(
  "restores the exact HttpOnly session authentication without contaminating another profile (%s)",
  async (afterCapture) => {
    const directory = await mkdtemp("/tmp/ogb-headless-auth-");
    const identities = new Map<string, string>([
      [randomUUID(), "alpha"],
      [randomUUID(), "beta"],
    ]);
    const issued = new Map<string, number>();
    let uploaded: Buffer | null = null;
    const web = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/profile.ogbs")
          return uploaded
            ? new Response(new Uint8Array(uploaded), {
                headers: { "content-length": String(uploaded.byteLength) },
              })
            : new Response("missing", { status: 404 });
        if (path.startsWith("/login/")) {
          const identity = path.slice("/login/".length);
          const token = [...identities].find(([, name]) => name === identity)?.[0];
          if (!token) return new Response("unknown", { status: 404 });
          issued.set(identity, (issued.get(identity) ?? 0) + 1);
          return new Response(null, {
            status: 303,
            headers: {
              location: "/account",
              "set-cookie": `private_auth=${token}; Path=/; HttpOnly; SameSite=Lax`,
            },
          });
        }
        const cookie = request.headers
          .get("cookie")
          ?.split(";")
          .map((entry) => entry.trim())
          .find((entry) => entry.startsWith("private_auth="))
          ?.slice("private_auth=".length);
        const identity = cookie ? identities.get(cookie) : undefined;
        return new Response(
          `<!doctype html><title>Private auth fixture</title><p>Authenticated ${identity ?? "guest"}</p>
        <p id="hidden"></p><script>document.getElementById("hidden").textContent=
        document.cookie.includes("private_auth")?"HttpOnly exposed":"HttpOnly hidden";</script>`,
          { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
        );
      },
    });
    const origin = web.url.toString().replace(/\/$/u, "");
    const shell = await resolvePinnedHeadlessShell(
      process.env.OPENGENI_BROWSERD_HEADLESS_SHELL_DIRECTORY!,
    );
    const supervisor = await BrowserSupervisor.open({
      rootDirectory: join(directory, "state"),
      headlessShell: shell,
      uploadArtifact: async (path) => {
        uploaded = await readFile(path);
      },
    });
    const alpha = reference(1),
      beta = reference(2),
      guest = reference(3),
      restored = reference(4);
    try {
      const first = await supervisor.createSession({
        ...alpha,
        headed: false,
        initialUrl: `${origin}/login/alpha`,
      });
      const other = await supervisor.createSession({
        ...beta,
        headed: false,
        initialUrl: `${origin}/login/beta`,
      });
      expect(await names(supervisor, alpha, first.observation.target.id)).toContain(
        "Authenticated alpha",
      );
      expect(await names(supervisor, beta, other.observation.target.id)).toContain(
        "Authenticated beta",
      );
      expect(await names(supervisor, alpha, first.observation.target.id)).toContain(
        "HttpOnly hidden",
      );
      const operationId = randomUUID();
      const objectKey = `workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/browser-state/revisions/${operationId}/chromium-profile.ogbs`;
      const key = Buffer.alloc(32, 0x72),
        aad = Buffer.from(`private-auth:${operationId}`);
      const captured = await supervisor.captureState({
        ...alpha,
        operationId,
        objectKey,
        afterCapture,
        dataKey: key,
        aad,
        upload: {
          url: `${origin}/upload`,
          requiredHeaders: { "content-type": BROWSER_STATE_ARTIFACT_CONTENT_TYPE },
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      });
      expect(uploaded).not.toBeNull();
      for (const token of identities.keys()) {
        expect(uploaded!.includes(Buffer.from(token))).toBe(false);
        expect(JSON.stringify(captured)).not.toContain(token);
      }
      if (afterCapture === "restart") {
        const targets = await supervisor.listTargets(alpha);
        expect(await names(supervisor, alpha, targets[0]!.id)).toContain("Authenticated alpha");
      }
      expect(await names(supervisor, beta, other.observation.target.id)).toContain(
        "Authenticated beta",
      );
      await supervisor.endSession(alpha, { removeState: true });
      const untouched = await supervisor.createSession({
        ...guest,
        headed: false,
        initialUrl: `${origin}/account`,
      });
      expect(await names(supervisor, guest, untouched.observation.target.id)).toContain(
        "Authenticated guest",
      );
      const materialized = await supervisor.createSession({
        ...restored,
        headed: false,
        initialUrl: `${origin}/account`,
        restore: {
          objectKey,
          format: captured.format,
          artifactDigest: captured.artifactDigest,
          contentDigest: captured.contentDigest,
          manifestDigest: new Bun.CryptoHasher("sha256")
            .update(stableJson(captured.manifest))
            .digest("hex"),
          sizeBytes: captured.sizeBytes,
          dataKey: key,
          aad,
          materialization: materialization(captured.manifest),
          download: {
            url: `${origin}/profile.ogbs`,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        },
      });
      const restoredNames = await names(supervisor, restored, materialized.observation.target.id);
      expect(restoredNames).toContain("Authenticated alpha");
      expect(restoredNames).toContain("HttpOnly hidden");
      expect(restoredNames).not.toContain("Authenticated beta");
      expect(await names(supervisor, beta, other.observation.target.id)).toContain(
        "Authenticated beta",
      );
      expect(await names(supervisor, guest, untouched.observation.target.id)).toContain(
        "Authenticated guest",
      );
      // Only initial logins issued tokens. Restore proved the very same cookie.
      expect(Object.fromEntries(issued)).toEqual({ alpha: 1, beta: 1 });
      expect(
        await noPrivateSidecar(
          join(directory, "state", "sessions", restored.browserSessionId, "profile"),
        ),
      ).toBe(true);
    } finally {
      await supervisor.close();
      web.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);
function reference(sequence: number) {
  return {
    browserSessionId: `77777777-7777-4777-8777-${String(sequence).padStart(12, "0")}`,
    controllerGeneration: `private-auth-controller-${sequence}`,
  };
}
async function names(
  supervisor: BrowserSupervisor,
  referenceValue: ReturnType<typeof reference>,
  targetId: string,
) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const observation = await supervisor.observe(referenceValue, targetId);
    const found = semanticNames(observation);
    if (
      found.some((name) => name.startsWith("Authenticated ")) &&
      found.includes("HttpOnly hidden")
    )
      return found;
    await Bun.sleep(50);
  }
  throw new Error("Private server-auth fixture did not become ready");
}
function semanticNames(observation: BrowserObservation): string[] {
  const result: string[] = [];
  const visit = (node: InteractionSemanticNodeValue) => {
    if (node.name) result.push(node.name);
    for (const child of node.children ?? []) visit(child);
  };
  if (observation.semantic?.kind === "snapshot")
    for (const node of observation.semantic.roots) visit(node);
  return result;
}
async function noPrivateSidecar(path: string): Promise<boolean> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.name.includes("session-cookies") || entry.name === "private") return false;
    if (entry.isDirectory() && !(await noPrivateSidecar(join(path, entry.name)))) return false;
  }
  return true;
}
function materialization(manifest: BrowserProfileManifest): BrowserRevisionMaterialization {
  return {
    portability: "portable",
    reason: null,
    platform: manifest.platform,
    architecture: manifest.architecture,
    engine: manifest.engine,
    engineVersion: manifest.engineVersion,
    driverId: manifest.driverId,
    driverSchemaVersion: manifest.driverSchemaVersion,
    profileCrypto: manifest.profileCrypto,
    providerId: null,
    placement: null,
  };
}

import { parentPort, workerData } from "node:worker_threads";
import { environmentsEncryptionKeyBytes } from "@opengeni/config";
import { testSettings } from "@opengeni/testing";
import {
  buildConnectionTokenResolver,
  createDb,
  encryptEnvironmentValue,
  loadConnectionCredentialForBroker,
  recordConnectionTokenRefresh,
  recordConnectionUsed,
  setConnectionStatus,
  type ConnectionBrokerDeps,
} from "../../src/index";

const port = parentPort;
if (!port) throw new Error("Refresh fixture requires a worker thread");
const input = workerData as {
  appUrl: string;
  encryptionKey: string;
  workspaceId: string;
  connectionId: string;
};
const client = createDb(input.appUrl);
const settings = testSettings({ environmentsEncryptionKey: input.encryptionKey });
const waitFor = (type: string) => new Promise<{ allowed?: boolean }>((resolve) => {
  const listener = (message: { type: string; allowed?: boolean }) => {
    if (message.type !== type) return;
    port.off("message", listener);
    resolve(message);
  };
  port.on("message", listener);
});
let initialRead = true;
const deps: ConnectionBrokerDeps = {
  loadCredential: async (database, config, lookup) => {
    const credential = await loadConnectionCredentialForBroker(database, config, lookup);
    if (initialRead) {
      initialRead = false;
      const proceed = waitFor("proceed");
      port.postMessage({ type: "ready" });
      await proceed;
    }
    return credential;
  },
  refresh: async () => {
    const reply = waitFor("exchange-result");
    port.postMessage({ type: "exchange" });
    if (!(await reply).allowed) throw new Error("Rotating token exchanged twice");
    return {
      credential: { access_token: "fresh-access", refresh_token: "fresh-refresh" },
      expiresAt: new Date(Date.now() + 3_600_000),
      grantedScopes: ["read"],
    };
  },
  recordRefresh: recordConnectionTokenRefresh,
  recordUsed: recordConnectionUsed,
  setStatus: setConnectionStatus,
  encrypt: encryptEnvironmentValue,
  keyBytes: environmentsEncryptionKeyBytes,
  now: () => new Date(),
};
try {
  const result = await buildConnectionTokenResolver(client.db, settings, deps)({
    workspaceId: input.workspaceId,
    serverId: "fixture",
    destinationUrl: "https://oauth.example.com/mcp",
    connectionRef: {
      providerDomain: "oauth.example.com",
      kind: "oauth2",
      connectionId: input.connectionId,
      scopes: ["read"],
    },
    forceRefresh: true,
  });
  await client.close();
  port.postMessage({ type: "result", result });
} catch (error) {
  await client.close();
  port.postMessage({ type: "failure", message: error instanceof Error ? error.message : "Worker failed" });
} finally {
  port.close();
}
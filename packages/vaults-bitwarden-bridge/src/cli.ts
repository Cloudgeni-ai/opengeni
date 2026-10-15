#!/usr/bin/env bun
/**
 * `opengeni-bitwarden-bridge --config /etc/opengeni/bitwarden-bridge.json`
 *
 * Runs next to a customer-run, already-unlocked `bw serve` on a private Unix
 * socket. The bridge never starts, logs in to or unlocks `bw`.
 */
import { ExternalVaultReceiverError } from "@opengeni/sdk/external-vault-receiver";
import { createBitwardenBridge } from "./bridge";
import { BitwardenServeClient, createUnixSocketBitwardenTransport } from "./bw-serve";
import { createFileExternalVaultReceiverStore } from "./file-store";
import { loadBitwardenBridgeConfigFile, serveBitwardenBridge } from "./server";

function usage(): never {
  console.error("usage: opengeni-bitwarden-bridge --config <absolute path to config.json>");
  process.exit(64);
}

async function main(argv: string[]) {
  const index = argv.indexOf("--config");
  const configPath = index >= 0 ? argv[index + 1] : undefined;
  if (!configPath) usage();
  const file = loadBitwardenBridgeConfigFile(configPath);
  const transport = createUnixSocketBitwardenTransport({
    socketPath: file.bwSocketPath,
    ...(file.bwServePort !== undefined ? { port: file.bwServePort } : {}),
  });
  const bridge = createBitwardenBridge({
    config: file.bridge,
    client: new BitwardenServeClient({ transport }),
    store: createFileExternalVaultReceiverStore({ directory: file.stateDir }),
    onError: ({ stage, op, error }) =>
      // The bridge's own refusal messages are value-free; other errors are not printed.
      console.error(
        error instanceof ExternalVaultReceiverError && error.message !== error.code
          ? `bridge ${op} refused: ${error.message}`
          : `bridge ${op} failed at ${stage}`,
      ),
  });
  const health = await bridge.health();
  console.error(`bw serve: ${health.status}; last sync ${health.lastSync ?? "never"}`);
  if (health.status !== "unlocked") {
    console.error(
      "unlock the vault locally (bw unlock) and restart bw serve; requests fail until then",
    );
  }
  const server = await serveBitwardenBridge({
    bridge,
    listen: file.listen,
    ...(file.path !== undefined ? { path: file.path } : {}),
  });
  console.error(`opengeni bitwarden bridge listening on ${server.address}`);
  const stop = () => {
    void server.close().then(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "bridge failed to start");
  process.exit(1);
});

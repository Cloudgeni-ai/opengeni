import { mintAuthResponse, mintUserJwt, nkeys, workspaceAgentPermissions } from "@opengeni/events";

// Synthetic keys only: no broker, credentials, database, or provider calls.
const accountSeed = new TextDecoder().decode(nkeys.createAccount().getSeed());
const userPublicKey = nkeys.createUser().getPublicKey();
const serverId = nkeys.createServer().getPublicKey();
const permissions = workspaceAgentPermissions("11111111-1111-4111-8111-111111111111");
const samples = [];
for (let round = 0; round < 10; round++) {
  const start = performance.now(),
    cpu = process.cpuUsage();
  let bytes = 0;
  for (let i = 0; i < 100; i++) {
    const userJwt = mintUserJwt({
      accountSeed,
      userPublicKey,
      name: "benchmark",
      permissions,
      audienceAccount: "APP",
      expiresAtSeconds: 2_000_000_000,
    });
    bytes += mintAuthResponse({ accountSeed, userPublicKey, serverId, userJwt }).length;
  }
  const usage = process.cpuUsage(cpu);
  samples.push({
    round,
    authorizations: 100,
    signatures: 200,
    ms: performance.now() - start,
    cpuMs: (usage.user + usage.system) / 1000,
    bytes,
  });
}
console.log(JSON.stringify({ samples }, null, 2));

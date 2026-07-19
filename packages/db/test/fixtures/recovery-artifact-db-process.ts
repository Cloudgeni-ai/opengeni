import { createDb, precomputeRecoveryArtifact } from "../../src/index";

type Input = {
  appUrl: string;
  accountId: string;
  workspaceId: string;
  rootSessionId: string;
};

const input = JSON.parse(await Bun.stdin.text()) as Input;
const client = createDb(input.appUrl);
try {
  const artifact = await precomputeRecoveryArtifact(client.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    rootSessionId: input.rootSessionId,
  });
  process.stdout.write(
    JSON.stringify({
      artifactHash: artifact.artifactHash,
      sessionCount: artifact.manifest.sessionCount,
      eventCount: artifact.manifest.eventCount,
      canonicalBytes: artifact.manifest.canonicalBytes,
    }),
  );
} finally {
  await client.close();
}
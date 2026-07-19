import { buildRecoveryArtifact, type RecoveryArtifactBuildInput } from "../../src/index";

const input = JSON.parse(await Bun.stdin.text()) as RecoveryArtifactBuildInput;
const artifact = buildRecoveryArtifact(input);
process.stdout.write(
  JSON.stringify({
    artifactHash: artifact.artifactHash,
    partitionHashes: artifact.manifest.partitions.map((partition) => partition.partitionHash),
  }),
);
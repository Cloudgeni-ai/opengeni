import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { attest } from "sigstore";
import { verifyCanaryController } from "./canary-source-admission";

/** The certificate remains the real controller; source material is a separate input. */
export function canarySourceStatement(
  manifest: Record<string, unknown>,
  packed: Buffer,
  env: Record<string, string | undefined>,
) {
  verifyCanaryController(env, env.GITHUB_SHA ?? "");
  if (
    !/^[1-9]\d*$/.test(env.GITHUB_RUN_ID ?? "") ||
    !/^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT ?? "") ||
    env.RUNNER_ENVIRONMENT !== "github-hosted"
  )
    throw new Error("Canary signing invocation invalid");
  const repository = "https://github.com/Cloudgeni-ai/opengeni";
  return {
    _type: "https://in-toto.io/Statement/v1",
    subject: [
      {
        name: `pkg:npm/${String(manifest.name).replace("@", "%40")}@${manifest.version}`,
        digest: { sha512: createHash("sha512").update(packed).digest("hex") },
      },
    ],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
        externalParameters: {
          workflow: {
            ref: "refs/heads/main",
            repository,
            path: ".github/workflows/publish-canary.yml",
          },
          source: { repository, commit: env.SOURCE_SHA },
        },
        internalParameters: {
          github: {
            event_name: "workflow_dispatch",
            repository_id: env.GITHUB_REPOSITORY_ID,
            repository_owner_id: env.GITHUB_REPOSITORY_OWNER_ID,
          },
        },
        resolvedDependencies: [
          { uri: `git+${repository}@refs/heads/main`, digest: { gitCommit: env.GITHUB_SHA } },
          { uri: `git+${repository}@${env.SOURCE_SHA}`, digest: { gitCommit: env.SOURCE_SHA } },
        ],
      },
      runDetails: {
        builder: { id: "https://github.com/actions/runner/github-hosted" },
        metadata: {
          invocationId: `${repository}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}`,
        },
      },
    },
  };
}

export type SuppliedCanaryProvenance = {
  file: string;
  transparencyLogUrl: string;
  evidence?: { file: string; bytes: number; sha256: string };
};

export async function signCanarySource(
  manifest: Record<string, unknown>,
  packed: Buffer,
  directory: string,
  env = process.env,
  sign: typeof attest = attest,
): Promise<SuppliedCanaryProvenance> {
  const payload = Buffer.from(JSON.stringify(canarySourceStatement(manifest, packed, env)));
  const bundle = await sign(payload, "application/vnd.in-toto+json", {
    retry: { retries: 0 },
    timeout: 30_000,
  });
  const index = bundle.verificationMaterial?.tlogEntries?.[0]?.logIndex;
  if (!/^\d+$/.test(index ?? "") || bundle.dsseEnvelope?.payload !== payload.toString("base64")) {
    throw new Error("Canary source provenance was not retained in transparency log");
  }
  const file = join(
    directory,
    `${createHash("sha256").update(packed).digest("hex")}.sigstore.json`,
  );
  const bytes = Buffer.from(JSON.stringify(bundle));
  writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
  // libnpmpublish verifies this bundle and its exact tarball subject before PUT.
  // Unlike automatic provenance, that branch does not return a transparency URL.
  return {
    file,
    transparencyLogUrl: `https://search.sigstore.dev/?logIndex=${index}`,
    evidence: {
      file: basename(file),
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
}

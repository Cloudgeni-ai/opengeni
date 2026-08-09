import { describe, expect, test } from "bun:test";
import packageJson from "../package.json" with { type: "json" };
import {
  ARTIFACT_RUNTIME_MATRIX,
  ARTIFACT_RUNTIME_TARGETS,
  ArtifactKernelRuntime,
  ArtifactRuntimeError,
  artifactRuntimeTarget,
  encodeArtifactReplicaNamespace,
  loadArtifactKernelRuntime,
  locateArtifactRuntimeDependencies,
  resolveArtifactRuntimeTarget,
  validateArtifactRuntimeInstallationManifest,
  validateCompleteArtifactRuntimeReleaseManifest,
  type ArtifactKernelPackageManifest,
  type ArtifactRuntimeInstallationManifest,
} from "../src/runtime";

const digest = `sha256:${"a".repeat(64)}` as const;
const packageVersion = packageJson.version;
const buildIdentity = `opengeni-artifact-kernel/${packageVersion};abi=1;source=test`;

describe("artifact runtime distribution", () => {
  test("owns one deterministic, complete target matrix", () => {
    expect(ARTIFACT_RUNTIME_MATRIX.map(({ target }) => target)).toEqual([
      ...ARTIFACT_RUNTIME_TARGETS,
    ]);
    expect(new Set(ARTIFACT_RUNTIME_MATRIX.map(({ packageName }) => packageName)).size).toBe(8);
    expect(
      resolveArtifactRuntimeTarget({ platform: "linux", arch: "arm64", libc: "musl" }).target,
    ).toBe("linux-arm64-musl");
    expect(resolveArtifactRuntimeTarget({ platform: "darwin", arch: "arm64" }).target).toBe(
      "darwin-arm64",
    );
    expect(() => resolveArtifactRuntimeTarget({ platform: "linux", arch: "x64" })).toThrow(
      "unknown-libc",
    );
    expect(() => resolveArtifactRuntimeTarget({ platform: "win32", arch: "arm64" })).toThrow(
      "ARTIFACT_RUNTIME_UNSUPPORTED_TARGET",
    );
    expect(encodeArtifactReplicaNamespace(7n)).toEqual(encodeArtifactReplicaNamespace(7n));
    expect(() => encodeArtifactReplicaNamespace(0n)).toThrow("nonzero u64");
    expect(() => encodeArtifactReplicaNamespace(1n << 64n)).toThrow("nonzero u64");
  });

  test("rejects incomplete, reordered, or mixed-build release matrices", () => {
    const complete = releaseManifest();
    expect(validateCompleteArtifactRuntimeReleaseManifest(complete).targets).toHaveLength(8);
    expect(() =>
      validateCompleteArtifactRuntimeReleaseManifest({
        ...complete,
        targets: complete.targets.slice(0, -1),
      }),
    ).toThrow("exactly 8 targets");
    expect(() =>
      validateCompleteArtifactRuntimeReleaseManifest({
        ...complete,
        targets: [complete.targets[1], complete.targets[0], ...complete.targets.slice(2)],
      }),
    ).toThrow("does not match");
    expect(() =>
      validateCompleteArtifactRuntimeReleaseManifest({
        ...complete,
        targets: complete.targets.map((target, index) =>
          index === 3 ? { ...target, buildIdentity: `${buildIdentity}-different` } : target,
        ),
      }),
    ).toThrow("one build identity");
  });

  test("validates one exact local installation and confines all paths", () => {
    const manifest = installationManifest();
    const parsed = validateArtifactRuntimeInstallationManifest(manifest, "darwin-arm64");
    expect(parsed.kernel.packageName).toBe("@opengeni/artifact-kernel-darwin-arm64");
    const located = locateArtifactRuntimeDependencies(
      manifest,
      new URL("file:///opt/opengeni/artifacts/runtime.json"),
      "darwin-arm64",
    );
    expect(located.skillFacadeEntrypoint.href).toBe(
      "file:///opt/opengeni/artifacts/artifact-tool/index.js",
    );
    expect(located.kernelAsset.href).toBe(
      "file:///opt/opengeni/artifacts/kernel/opengeni_artifact_kernel.node",
    );
    expect(() =>
      validateArtifactRuntimeInstallationManifest({
        ...manifest,
        skillFacadeEntrypoint: {
          ...manifest.skillFacadeEntrypoint,
          path: "../user-repo/index.js",
        },
      }),
    ).toThrow("normalized relative POSIX path");
    expect(() =>
      validateArtifactRuntimeInstallationManifest({ ...manifest, extraAuthority: true }),
    ).toThrow("unexpected fields");
  });

  test("validates a bounded, collision-free portable facade closure", () => {
    const manifest = {
      ...installationManifest(),
      artifactToolArchive: { path: "artifact-tool.tgz", bytes: 4096, sha256: digest },
      skillFacadeSupportFiles: [
        { path: "node_modules/a/index.js", bytes: 32, sha256: digest },
        { path: "opengeni-artifact-runtime.mjs", bytes: 64, sha256: digest },
      ],
    } satisfies ArtifactRuntimeInstallationManifest;
    const parsed = validateArtifactRuntimeInstallationManifest(manifest);
    expect(parsed.skillFacadeSupportFiles).toHaveLength(2);
    const dependencies = locateArtifactRuntimeDependencies(
      manifest,
      new URL("file:///opt/opengeni/artifacts/installation.json"),
    );
    expect(dependencies.artifactToolArchiveUrl?.href).toBe(
      "file:///opt/opengeni/artifacts/artifact-tool.tgz",
    );
    expect(dependencies.skillFacadeSupportFiles.map(String)).toEqual([
      "file:///opt/opengeni/artifacts/node_modules/a/index.js",
      "file:///opt/opengeni/artifacts/opengeni-artifact-runtime.mjs",
    ]);

    expect(() =>
      validateArtifactRuntimeInstallationManifest({
        ...manifest,
        skillFacadeSupportFiles: [...manifest.skillFacadeSupportFiles].reverse(),
      }),
    ).toThrow("strictly sorted");
    expect(() =>
      validateArtifactRuntimeInstallationManifest({
        ...manifest,
        skillFacadeSupportFiles: [
          { path: manifest.releaseManifest.path, bytes: 32, sha256: digest },
        ],
      }),
    ).toThrow("collision-free");
    expect(() =>
      validateArtifactRuntimeInstallationManifest({
        ...manifest,
        skillFacadeSupportFiles: [{ path: "kernel/index.js", bytes: 32, sha256: digest }],
      }),
    ).toThrow("collision-free");
    expect(() =>
      validateArtifactRuntimeInstallationManifest({
        ...manifest,
        skillFacadeSupportFiles: [
          { path: "node_modules/a", bytes: 160 * 1024 * 1024, sha256: digest },
          { path: "node_modules/b", bytes: 160 * 1024 * 1024, sha256: digest },
        ],
      }),
    ).toThrow("256 MiB");
  });

  test("loads only the selected package and validates package identity plus ABI", async () => {
    const dependencies = locateArtifactRuntimeDependencies(
      installationManifest(),
      new URL("file:///opt/opengeni/artifacts/runtime.json"),
    );
    const imported: string[] = [];
    const runtime = await loadArtifactKernelRuntime(dependencies, async (specifier) => {
      imported.push(specifier);
      return {
        artifactKernelPackageIdentity: packageIdentity(dependencies.manifest.kernel),
        loadArtifactKernelBinding: () => fakeBinding(),
      };
    });
    expect(imported).toEqual(["file:///opt/opengeni/artifacts/kernel/index.js"]);
    expect(runtime.kind).toBe("native");
    expect(runtime.target).toBe("darwin-arm64");
    expect(runtime.buildIdentity).toBe(buildIdentity);
    const session = runtime.createCollaborationSession(7n);
    expect(session.queryViewport(new Uint8Array([1]))).toEqual(new Uint8Array([9]));
    expect(session.authorTransaction(new Uint8Array([1]), new Uint8Array([2]))).toEqual(
      new Uint8Array([8]),
    );
    expect(session.revision()).toBe(0n);
    session.dispose();
    expect(session.isClosed()).toBe(true);
  });

  test("fails closed for absent packages, mismatched manifests, and incomplete bindings", async () => {
    const dependencies = locateArtifactRuntimeDependencies(
      installationManifest(),
      new URL("file:///opt/opengeni/artifacts/runtime.json"),
    );
    await expect(
      loadArtifactKernelRuntime(dependencies, () => {
        throw new Error("missing");
      }),
    ).rejects.toThrow("ARTIFACT_RUNTIME_UNAVAILABLE");
    await expect(
      loadArtifactKernelRuntime(dependencies, () => ({
        artifactKernelPackageIdentity: {
          ...packageIdentity(dependencies.manifest.kernel),
          buildIdentity: "other-build",
        },
        loadArtifactKernelBinding: () => fakeBinding(),
      })),
    ).rejects.toThrow("ARTIFACT_RUNTIME_INTEGRITY");
    expect(() => new ArtifactKernelRuntime("native", {}, dependencies.manifest.kernel)).toThrow(
      "ARTIFACT_RUNTIME_INCOMPATIBLE",
    );
  });

  test("uses stable typed errors", () => {
    try {
      artifactRuntimeTarget("not-real" as never);
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ArtifactRuntimeError);
      expect((error as ArtifactRuntimeError).code).toBe("ARTIFACT_RUNTIME_UNSUPPORTED_TARGET");
    }
  });
});

function packageManifest(target = "darwin-arm64" as const): ArtifactKernelPackageManifest {
  const descriptor = artifactRuntimeTarget(target);
  return {
    schemaVersion: 1,
    target,
    kind: descriptor.kind,
    packageName: descriptor.packageName,
    packageVersion,
    artifactToolVersion: packageVersion,
    buildIdentity,
    entrypoint: {
      path: "index.js",
      bytes: 256,
      sha256: digest,
    },
    asset: {
      path: "opengeni_artifact_kernel.node",
      bytes: 1024,
      sha256: digest,
    },
    supportFiles: [],
  };
}

function installationManifest(): ArtifactRuntimeInstallationManifest {
  return {
    schemaVersion: 1,
    target: "darwin-arm64",
    releaseManifest: {
      path: "release-manifest.json",
      bytes: 2048,
      sha256: digest,
    },
    artifactTool: {
      packageName: "@opengeni/artifact-tool",
      packageVersion,
      integrity: `sha512-${"a".repeat(86)}==`,
    },
    skillFacadeEntrypoint: {
      path: "artifact-tool/index.js",
      bytes: 512,
      sha256: digest,
    },
    kernelPackageRoot: "kernel",
    kernel: packageManifest(),
  };
}

function packageIdentity(manifest: ArtifactKernelPackageManifest) {
  const {
    schemaVersion,
    target,
    kind,
    packageName,
    packageVersion: identityPackageVersion,
    artifactToolVersion,
    buildIdentity: identityBuildIdentity,
  } = manifest;
  return {
    schemaVersion,
    target,
    kind,
    packageName,
    packageVersion: identityPackageVersion,
    artifactToolVersion,
    buildIdentity: identityBuildIdentity,
  };
}

function releaseManifest() {
  return {
    schemaVersion: 1,
    artifactTool: {
      packageName: "@opengeni/artifact-tool",
      packageVersion,
      integrity: `sha512-${"a".repeat(86)}==`,
    },
    targets: ARTIFACT_RUNTIME_MATRIX.map((descriptor, index) => ({
      schemaVersion: 1,
      target: descriptor.target,
      kind: descriptor.kind,
      packageName: descriptor.packageName,
      packageVersion,
      artifactToolVersion: packageVersion,
      buildIdentity,
      entrypoint: {
        path: "index.js",
        bytes: 256 + index,
        sha256: `sha256:${(index + 8).toString(16).padStart(64, "0")}`,
      },
      asset: {
        path:
          descriptor.kind === "wasm" ? "artifact_kernel_bg.wasm" : "opengeni_artifact_kernel.node",
        bytes: 1024 + index,
        sha256: `sha256:${index.toString(16).padStart(64, "0")}`,
      },
      supportFiles: [],
    })),
  };
}

function fakeBinding() {
  const encodedCapabilities = new TextEncoder().encode(
    JSON.stringify({
      abiVersion: 1,
      buildIdentityFormat: "utf8",
      commandSchemaVersion: 1,
      spreadsheetCommandVersion: 1,
      kernelSnapshotVersion: 1,
      receiptSchemaVersion: 1,
      collaborationSnapshotVersion: 1,
      editableArtifactIntentVersion: 1,
      committedTransactionVersion: 1,
      queryVersion: 1,
      queryResponseVersion: 1,
      collaboration: true,
      document: true,
      documentCommandVersion: 1,
      documentQueryResponseVersion: 1,
      documentQueryVersion: 1,
      documentReceiptVersion: 1,
      documentSnapshotVersion: 1,
      documentStatefulSessions: true,
      presentation: true,
      presentationCommandVersion: 1,
      presentationQueryResponseVersion: 1,
      presentationQueryVersion: 1,
      presentationSnapshotVersion: 1,
      presentationStatefulSessions: true,
      textLayout: true,
      textLayoutFontBundleVersion: 1,
      textLayoutRequestVersion: 1,
      textLayoutResponseVersion: 1,
      textLayoutStatefulSessions: true,
      retainedRenderPatchVersion: 1,
      retainedRenderTileVersion: 1,
      workbookMetadataQueries: true,
      canonicalStateHash: "sha256:canonical-snapshot",
      maxCellsPerBatch: 1,
      maxCommandBytes: 1,
      maxCommands: 1,
      maxCommittedTransactionBytes: 1,
      maxDocumentCommandBytes: 1,
      maxDocumentCommands: 1,
      maxDocumentQueryBytes: 1,
      maxDocumentQueryResponseBytes: 1,
      maxDocumentSnapshotBytes: 1,
      maxIntentBytes: 1,
      maxMetadataScannedCells: 1,
      maxMetadataSheets: 1,
      maxPresentationCommandBytes: 1,
      maxPresentationQueryBytes: 1,
      maxPresentationResponseBytes: 1,
      maxPresentationSnapshotBytes: 1,
      maxQueryBytes: 1,
      maxQueryResponseBytes: 1,
      maxSnapshotBytes: 1,
      maxSpreadsheetCommandBytes: 1,
      maxTextLayoutFontBundleBytes: 1,
      maxTextLayoutRequestBytes: 1,
      maxTextLayoutResponseBytes: 1,
      maxViewportArea: 1,
      maxViewportCells: 1,
      safeRust: true,
      sessionForks: true,
      statefulSessions: true,
      transport: "bounded-uint8array",
    }),
  );
  class Session {
    closed = false;
    static create(): Session {
      return new Session();
    }
    static open(): Session {
      return new Session();
    }
    authorTransaction(): Uint8Array {
      return new Uint8Array([8]);
    }
    applyCommitted(): void {}
    applyCommands(commands: Uint8Array): Uint8Array {
      return commands;
    }
    query(): Uint8Array {
      return new Uint8Array([9]);
    }
    snapshot(): Uint8Array {
      return new Uint8Array([1]);
    }
    frontier(): Uint8Array {
      return new Uint8Array([2]);
    }
    stateHash(): string {
      return `sha256:${"0".repeat(64)}`;
    }
    revision(): bigint {
      return 0n;
    }
    fork(): Session {
      return new Session();
    }
    close(): void {
      this.closed = true;
    }
    dispose(): void {
      this.closed = true;
    }
  }
  return {
    capabilities: () => encodedCapabilities,
    buildIdentity: () => new TextEncoder().encode(buildIdentity),
    createDocument: (namespace: Uint8Array) => namespace,
    applyDocumentCommands: (_snapshot: Uint8Array, commands: Uint8Array) => commands,
    queryDocument: (_snapshot: Uint8Array, query: Uint8Array) => query,
    canonicalizeDocumentSnapshot: (snapshot: Uint8Array) => snapshot,
    createPresentation: (namespace: Uint8Array) => namespace,
    applyPresentationCommands: (_snapshot: Uint8Array, commands: Uint8Array) => commands,
    queryPresentation: (_snapshot: Uint8Array, query: Uint8Array) => query,
    canonicalizePresentationSnapshot: (snapshot: Uint8Array) => snapshot,
    layoutText: (_fontBundle: Uint8Array, request: Uint8Array) => request,
    canonicalizeRenderTile: (value: Uint8Array) => value,
    canonicalizeRenderPatch: (value: Uint8Array) => value,
    canonicalizeCollaborationSnapshot: (snapshot: Uint8Array) => snapshot,
    ArtifactCollaborationSession: Session,
    ArtifactDocumentSession: Session,
    ArtifactPresentationSession: Session,
    ArtifactTextLayoutSession: class TextLayoutSession {
      closed = false;
      static open(): TextLayoutSession {
        return new TextLayoutSession();
      }
      layout(request: Uint8Array): Uint8Array {
        return request;
      }
      dispose(): void {
        this.closed = true;
      }
    },
  };
}

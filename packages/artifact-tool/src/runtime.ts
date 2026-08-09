/**
 * Exact artifact-kernel distribution and runtime boundary.
 *
 * This module never downloads a binary, installs a package, guesses `latest`,
 * or falls back to the TypeScript reference implementation. A host supplies
 * one exact, locally installed target package and this boundary verifies its
 * manifest and byte ABI before exposing a kernel session.
 */

export const ARTIFACT_RUNTIME_ENVIRONMENT = {
  manifest: "OPENGENI_ARTIFACT_RUNTIME_MANIFEST",
  toolEntrypoint: "OPENGENI_ARTIFACT_TOOL_ENTRY",
} as const;

export const ARTIFACT_RUNTIME_TARGETS = [
  "darwin-x64",
  "darwin-arm64",
  "linux-x64-gnu",
  "linux-arm64-gnu",
  "linux-x64-musl",
  "linux-arm64-musl",
  "win32-x64-msvc",
  "wasm-web",
] as const;

export type ArtifactRuntimeTarget = (typeof ARTIFACT_RUNTIME_TARGETS)[number];
export type NativeArtifactRuntimeTarget = Exclude<ArtifactRuntimeTarget, "wasm-web">;
export type ArtifactRuntimeKind = "native" | "wasm";
export type ArtifactRuntimeLibc = "gnu" | "musl";

export type ArtifactRuntimeTargetDescriptor = {
  readonly target: ArtifactRuntimeTarget;
  readonly kind: ArtifactRuntimeKind;
  readonly packageName: ArtifactKernelPackageName;
  readonly platform: "darwin" | "linux" | "win32" | "browser";
  readonly arch: "x64" | "arm64" | "wasm32";
  readonly libc?: ArtifactRuntimeLibc;
};

export const ARTIFACT_RUNTIME_MATRIX = [
  descriptor("darwin-x64", "native", "darwin", "x64"),
  descriptor("darwin-arm64", "native", "darwin", "arm64"),
  descriptor("linux-x64-gnu", "native", "linux", "x64", "gnu"),
  descriptor("linux-arm64-gnu", "native", "linux", "arm64", "gnu"),
  descriptor("linux-x64-musl", "native", "linux", "x64", "musl"),
  descriptor("linux-arm64-musl", "native", "linux", "arm64", "musl"),
  descriptor("win32-x64-msvc", "native", "win32", "x64"),
  descriptor("wasm-web", "wasm", "browser", "wasm32"),
] as const satisfies readonly ArtifactRuntimeTargetDescriptor[];

export type ArtifactKernelPackageName = `@opengeni/artifact-kernel-${ArtifactRuntimeTarget}`;

export type ArtifactKernelPackageManifest = {
  readonly schemaVersion: 1;
  readonly target: ArtifactRuntimeTarget;
  readonly kind: ArtifactRuntimeKind;
  readonly packageName: ArtifactKernelPackageName;
  readonly packageVersion: string;
  readonly artifactToolVersion: string;
  readonly buildIdentity: string;
  readonly entrypoint: {
    readonly path: string;
    readonly bytes: number;
    readonly sha256: `sha256:${string}`;
  };
  readonly asset: {
    readonly path: string;
    readonly bytes: number;
    readonly sha256: `sha256:${string}`;
  };
  /** Additional executable runtime files (for example wasm-bindgen glue). */
  readonly supportFiles: readonly {
    readonly path: string;
    readonly bytes: number;
    readonly sha256: `sha256:${string}`;
  }[];
};

/** Self-contained identity embedded in executable package code (no self-hash). */
export type ArtifactKernelPackageIdentity = Pick<
  ArtifactKernelPackageManifest,
  | "schemaVersion"
  | "target"
  | "kind"
  | "packageName"
  | "packageVersion"
  | "artifactToolVersion"
  | "buildIdentity"
>;

export type ArtifactRuntimeInstallationManifest = {
  readonly schemaVersion: 1;
  readonly target: ArtifactRuntimeTarget;
  readonly releaseManifest: {
    readonly path: string;
    readonly bytes: number;
    readonly sha256: `sha256:${string}`;
  };
  readonly artifactTool: {
    readonly packageName: "@opengeni/artifact-tool";
    readonly packageVersion: string;
    readonly integrity: `sha512-${string}`;
  };
  readonly skillFacadeEntrypoint: {
    readonly path: string;
    readonly bytes: number;
    readonly sha256: `sha256:${string}`;
  };
  readonly kernelPackageRoot: string;
  readonly kernel: ArtifactKernelPackageManifest;
};

export type ArtifactRuntimeReleaseManifest = {
  readonly schemaVersion: 1;
  readonly artifactTool: {
    readonly packageName: "@opengeni/artifact-tool";
    readonly packageVersion: string;
    readonly integrity: `sha512-${string}`;
  };
  readonly targets: readonly ArtifactKernelPackageManifest[];
};

export type ArtifactRuntimeDependencies = {
  readonly target: ArtifactRuntimeTargetDescriptor;
  readonly manifestUrl: URL;
  readonly releaseManifestUrl: URL;
  readonly skillFacadeEntrypoint: URL;
  readonly kernelEntrypoint: URL;
  readonly kernelAsset: URL;
  readonly kernelSupportFiles: readonly URL[];
  readonly manifest: ArtifactRuntimeInstallationManifest;
};

export type ArtifactRuntimeKernelDependencies = Pick<
  ArtifactRuntimeDependencies,
  "target" | "kernelEntrypoint"
> &
  Readonly<{
    manifest: Pick<ArtifactRuntimeInstallationManifest, "kernel">;
  }>;

export type ArtifactKernelCapabilities = {
  readonly abiVersion: 1;
  readonly buildIdentityFormat: "utf8";
  readonly commandSchemaVersion: 1;
  readonly spreadsheetCommandVersion: 1;
  readonly kernelSnapshotVersion: 1;
  readonly receiptSchemaVersion: 1;
  readonly collaborationSnapshotVersion: 1;
  readonly editableArtifactIntentVersion: 1;
  readonly committedTransactionVersion: 1;
  readonly queryVersion: 1;
  readonly queryResponseVersion: 1;
  readonly collaboration: true;
  readonly document: true;
  readonly documentCommandVersion: 1;
  readonly documentQueryResponseVersion: 1;
  readonly documentQueryVersion: 1;
  readonly documentReceiptVersion: 1;
  readonly documentSnapshotVersion: 1;
  readonly documentStatefulSessions: true;
  readonly presentation: true;
  readonly presentationCommandVersion: 1;
  readonly presentationQueryResponseVersion: 1;
  readonly presentationQueryVersion: 1;
  readonly presentationSnapshotVersion: 1;
  readonly presentationStatefulSessions: true;
  readonly textLayout: true;
  readonly textLayoutFontBundleVersion: 1;
  readonly textLayoutRequestVersion: 1;
  readonly textLayoutResponseVersion: 1;
  readonly textLayoutStatefulSessions: true;
  readonly retainedRenderPatchVersion: 1;
  readonly retainedRenderTileVersion: 1;
  readonly workbookMetadataQueries: true;
  readonly canonicalStateHash: "sha256:canonical-snapshot";
  readonly maxCellsPerBatch: number;
  readonly maxCommandBytes: number;
  readonly maxCommands: number;
  readonly maxCommittedTransactionBytes: number;
  readonly maxDocumentCommandBytes: number;
  readonly maxDocumentCommands: number;
  readonly maxDocumentQueryBytes: number;
  readonly maxDocumentQueryResponseBytes: number;
  readonly maxDocumentSnapshotBytes: number;
  readonly maxIntentBytes: number;
  readonly maxMetadataScannedCells: number;
  readonly maxMetadataSheets: number;
  readonly maxPresentationCommandBytes: number;
  readonly maxPresentationQueryBytes: number;
  readonly maxPresentationResponseBytes: number;
  readonly maxPresentationSnapshotBytes: number;
  readonly maxQueryBytes: number;
  readonly maxQueryResponseBytes: number;
  readonly maxSnapshotBytes: number;
  readonly maxSpreadsheetCommandBytes: number;
  readonly maxTextLayoutFontBundleBytes: number;
  readonly maxTextLayoutRequestBytes: number;
  readonly maxTextLayoutResponseBytes: number;
  readonly maxViewportArea: number;
  readonly maxViewportCells: number;
  readonly safeRust: true;
  readonly sessionForks: true;
  readonly statefulSessions: true;
  readonly transport: "bounded-uint8array";
};

export type ArtifactKernelPackageModule = {
  readonly artifactKernelPackageIdentity: unknown;
  readonly loadArtifactKernelBinding: () => unknown | Promise<unknown>;
};

export type ArtifactRuntimeModuleImporter = (specifier: string) => unknown | Promise<unknown>;

export type ArtifactRuntimeErrorCode =
  | "ARTIFACT_RUNTIME_INCOMPATIBLE"
  | "ARTIFACT_RUNTIME_INTEGRITY"
  | "ARTIFACT_RUNTIME_MANIFEST_INVALID"
  | "ARTIFACT_RUNTIME_UNAVAILABLE"
  | "ARTIFACT_RUNTIME_UNSUPPORTED_TARGET";

export class ArtifactRuntimeError extends Error {
  readonly code: ArtifactRuntimeErrorCode;

  constructor(code: ArtifactRuntimeErrorCode, message: string, options?: ErrorOptions) {
    super(`[${code}] ${message}`, options);
    this.name = "ArtifactRuntimeError";
    this.code = code;
  }
}

export function resolveArtifactRuntimeTarget(input: {
  readonly platform: string;
  readonly arch: string;
  readonly libc?: ArtifactRuntimeLibc;
}): ArtifactRuntimeTargetDescriptor {
  const match = ARTIFACT_RUNTIME_MATRIX.find(
    (entry) =>
      entry.platform === input.platform &&
      entry.arch === input.arch &&
      (entry.platform !== "linux" || entry.libc === input.libc),
  );
  if (match) return match;
  const libc = input.platform === "linux" ? `/${input.libc ?? "unknown-libc"}` : "";
  throw new ArtifactRuntimeError(
    "ARTIFACT_RUNTIME_UNSUPPORTED_TARGET",
    `No artifact kernel is published for ${input.platform}/${input.arch}${libc}`,
  );
}

export function artifactRuntimeTarget(
  target: ArtifactRuntimeTarget,
): ArtifactRuntimeTargetDescriptor {
  const match = ARTIFACT_RUNTIME_MATRIX.find((entry) => entry.target === target);
  if (!match) {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_UNSUPPORTED_TARGET",
      `Unknown artifact runtime target: ${String(target)}`,
    );
  }
  return match;
}

export function validateArtifactKernelPackageManifest(
  value: unknown,
  expectedTarget?: ArtifactRuntimeTarget,
): ArtifactKernelPackageManifest {
  const record = exactRecord(
    value,
    [
      "schemaVersion",
      "target",
      "kind",
      "packageName",
      "packageVersion",
      "artifactToolVersion",
      "buildIdentity",
      "entrypoint",
      "asset",
      "supportFiles",
    ],
    "kernel package manifest",
  );
  if (record.schemaVersion !== 1) invalid("kernel package manifest schemaVersion must be 1");
  if (!isArtifactRuntimeTarget(record.target)) invalid("kernel package manifest target is invalid");
  const target = artifactRuntimeTarget(record.target);
  if (expectedTarget !== undefined && target.target !== expectedTarget) {
    invalid(`kernel package target ${target.target} does not match ${expectedTarget}`);
  }
  if (record.kind !== target.kind) invalid("kernel package kind does not match its target");
  if (record.packageName !== target.packageName) {
    invalid("kernel package name does not match its target");
  }
  const packageVersion = exactStableVersion(record.packageVersion, "kernel package version");
  const artifactToolVersion = exactStableVersion(
    record.artifactToolVersion,
    "artifact-tool compatibility version",
  );
  if (packageVersion !== artifactToolVersion) {
    invalid("kernel and artifact-tool versions must be identical");
  }
  const buildIdentity = boundedString(record.buildIdentity, "kernel build identity", 512);
  const entrypoint = exactRecord(
    record.entrypoint,
    ["path", "bytes", "sha256"],
    "kernel entrypoint",
  );
  const asset = exactRecord(record.asset, ["path", "bytes", "sha256"], "kernel asset");
  if (!Array.isArray(record.supportFiles) || record.supportFiles.length > 32) {
    invalid("kernel supportFiles must be an array with at most 32 entries");
  }
  const supportFiles = record.supportFiles.map((supportFile, index) => {
    const file = exactRecord(
      supportFile,
      ["path", "bytes", "sha256"],
      `kernel support file ${index}`,
    );
    return {
      path: safeRelativePath(file.path, `kernel support file ${index} path`),
      bytes: positiveSafeInteger(file.bytes, `kernel support file ${index} bytes`),
      sha256: sha256(file.sha256, `kernel support file ${index} sha256`),
    };
  });
  const runtimePaths = [entrypoint.path, asset.path, ...supportFiles.map((file) => file.path)];
  if (new Set(runtimePaths).size !== runtimePaths.length) {
    invalid("kernel runtime file paths must be unique");
  }
  if (
    !supportFiles.every((file, index) => index === 0 || supportFiles[index - 1]!.path < file.path)
  ) {
    invalid("kernel supportFiles must be strictly sorted by path");
  }
  return {
    schemaVersion: 1,
    target: target.target,
    kind: target.kind,
    packageName: target.packageName,
    packageVersion,
    artifactToolVersion,
    buildIdentity,
    entrypoint: {
      path: safeRelativePath(entrypoint.path, "kernel entrypoint path"),
      bytes: positiveSafeInteger(entrypoint.bytes, "kernel entrypoint bytes"),
      sha256: sha256(entrypoint.sha256, "kernel entrypoint sha256"),
    },
    asset: {
      path: safeRelativePath(asset.path, "kernel asset path"),
      bytes: positiveSafeInteger(asset.bytes, "kernel asset bytes"),
      sha256: sha256(asset.sha256, "kernel asset sha256"),
    },
    supportFiles,
  };
}

export function validateArtifactKernelPackageIdentity(
  value: unknown,
  expectedTarget?: ArtifactRuntimeTarget,
): ArtifactKernelPackageIdentity {
  const record = exactRecord(
    value,
    [
      "schemaVersion",
      "target",
      "kind",
      "packageName",
      "packageVersion",
      "artifactToolVersion",
      "buildIdentity",
    ],
    "kernel package identity",
  );
  if (record.schemaVersion !== 1) invalid("kernel package identity schemaVersion must be 1");
  if (!isArtifactRuntimeTarget(record.target)) invalid("kernel package identity target is invalid");
  const target = artifactRuntimeTarget(record.target);
  if (expectedTarget !== undefined && target.target !== expectedTarget) {
    invalid(`kernel package identity target ${target.target} does not match ${expectedTarget}`);
  }
  if (record.kind !== target.kind)
    invalid("kernel package identity kind does not match its target");
  if (record.packageName !== target.packageName) {
    invalid("kernel package identity name does not match its target");
  }
  const packageVersion = exactStableVersion(
    record.packageVersion,
    "kernel package identity version",
  );
  const artifactToolVersion = exactStableVersion(
    record.artifactToolVersion,
    "kernel package identity artifact-tool version",
  );
  if (packageVersion !== artifactToolVersion) {
    invalid("kernel package identity versions must be identical");
  }
  return {
    schemaVersion: 1,
    target: target.target,
    kind: target.kind,
    packageName: target.packageName,
    packageVersion,
    artifactToolVersion,
    buildIdentity: boundedString(
      record.buildIdentity,
      "kernel package identity build identity",
      512,
    ),
  };
}

export function validateArtifactRuntimeInstallationManifest(
  value: unknown,
  expectedTarget?: ArtifactRuntimeTarget,
): ArtifactRuntimeInstallationManifest {
  const record = exactRecord(
    value,
    [
      "schemaVersion",
      "target",
      "releaseManifest",
      "artifactTool",
      "skillFacadeEntrypoint",
      "kernelPackageRoot",
      "kernel",
    ],
    "artifact runtime installation manifest",
  );
  if (record.schemaVersion !== 1) invalid("installation manifest schemaVersion must be 1");
  if (!isArtifactRuntimeTarget(record.target)) invalid("installation manifest target is invalid");
  if (expectedTarget !== undefined && record.target !== expectedTarget) {
    invalid(`installation target ${record.target} does not match ${expectedTarget}`);
  }
  const releaseManifest = exactRecord(
    record.releaseManifest,
    ["path", "bytes", "sha256"],
    "release manifest file",
  );
  const artifactTool = exactRecord(
    record.artifactTool,
    ["packageName", "packageVersion", "integrity"],
    "artifact-tool installation",
  );
  if (artifactTool.packageName !== "@opengeni/artifact-tool") {
    invalid("artifact-tool package name is invalid");
  }
  const packageVersion = exactStableVersion(artifactTool.packageVersion, "artifact-tool version");
  const integrity = sha512Integrity(artifactTool.integrity, "artifact-tool integrity");
  const skillFacadeEntrypoint = exactRecord(
    record.skillFacadeEntrypoint,
    ["path", "bytes", "sha256"],
    "skill facade entrypoint",
  );
  const kernel = validateArtifactKernelPackageManifest(record.kernel, record.target);
  if (kernel.artifactToolVersion !== packageVersion) {
    invalid("installed artifact-tool and kernel versions must be identical");
  }
  return {
    schemaVersion: 1,
    target: record.target,
    releaseManifest: {
      path: safeRelativePath(releaseManifest.path, "release manifest path"),
      bytes: positiveSafeInteger(releaseManifest.bytes, "release manifest bytes"),
      sha256: sha256(releaseManifest.sha256, "release manifest sha256"),
    },
    artifactTool: {
      packageName: "@opengeni/artifact-tool",
      packageVersion,
      integrity,
    },
    skillFacadeEntrypoint: {
      path: safeRelativePath(skillFacadeEntrypoint.path, "skill facade entrypoint path"),
      bytes: positiveSafeInteger(skillFacadeEntrypoint.bytes, "skill facade entrypoint bytes"),
      sha256: sha256(skillFacadeEntrypoint.sha256, "skill facade entrypoint sha256"),
    },
    kernelPackageRoot: safeRelativePath(record.kernelPackageRoot, "kernel package root"),
    kernel: {
      ...kernel,
    },
  };
}

export function validateCompleteArtifactRuntimeReleaseManifest(
  value: unknown,
): ArtifactRuntimeReleaseManifest {
  const record = exactRecord(
    value,
    ["schemaVersion", "artifactTool", "targets"],
    "release manifest",
  );
  if (record.schemaVersion !== 1) invalid("release manifest schemaVersion must be 1");
  const artifactTool = exactRecord(
    record.artifactTool,
    ["packageName", "packageVersion", "integrity"],
    "release artifact-tool",
  );
  if (artifactTool.packageName !== "@opengeni/artifact-tool") {
    invalid("release artifact-tool package name is invalid");
  }
  const packageVersion = exactStableVersion(
    artifactTool.packageVersion,
    "release artifact-tool version",
  );
  const integrity = sha512Integrity(artifactTool.integrity, "release artifact-tool integrity");
  if (!Array.isArray(record.targets)) invalid("release targets must be an array");
  if (record.targets.length !== ARTIFACT_RUNTIME_MATRIX.length) {
    invalid(`release manifest must contain exactly ${ARTIFACT_RUNTIME_MATRIX.length} targets`);
  }
  const targets = record.targets.map((entry, index) => {
    const expected = ARTIFACT_RUNTIME_MATRIX[index]!;
    const target = validateArtifactKernelPackageManifest(entry, expected.target);
    if (target.artifactToolVersion !== packageVersion) {
      invalid(`target ${target.target} does not match artifact-tool ${packageVersion}`);
    }
    return target;
  });
  const buildIdentities = new Set(targets.map((target) => target.buildIdentity));
  if (buildIdentities.size !== 1) invalid("all target packages must carry one build identity");
  return {
    schemaVersion: 1,
    artifactTool: {
      packageName: "@opengeni/artifact-tool",
      packageVersion,
      integrity,
    },
    targets,
  };
}

export function locateArtifactRuntimeDependencies(
  value: unknown,
  manifestUrl: URL,
  expectedTarget?: ArtifactRuntimeTarget,
): ArtifactRuntimeDependencies {
  if (manifestUrl.protocol !== "file:") {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_MANIFEST_INVALID",
      "Installed runtime manifest must be a local file URL",
    );
  }
  const manifest = validateArtifactRuntimeInstallationManifest(value, expectedTarget);
  const root = new URL("./", manifestUrl);
  const kernelRoot = confinedUrl(root, `${manifest.kernelPackageRoot}/`);
  return {
    target: artifactRuntimeTarget(manifest.target),
    manifestUrl,
    releaseManifestUrl: confinedUrl(root, manifest.releaseManifest.path),
    skillFacadeEntrypoint: confinedUrl(root, manifest.skillFacadeEntrypoint.path),
    kernelEntrypoint: confinedUrl(kernelRoot, manifest.kernel.entrypoint.path),
    kernelAsset: confinedUrl(kernelRoot, manifest.kernel.asset.path),
    kernelSupportFiles: manifest.kernel.supportFiles.map((file) =>
      confinedUrl(kernelRoot, file.path),
    ),
    manifest,
  };
}

export async function loadArtifactKernelRuntime(
  dependencies: ArtifactRuntimeKernelDependencies,
  importer: ArtifactRuntimeModuleImporter = defaultModuleImporter,
): Promise<ArtifactKernelRuntime> {
  let imported: unknown;
  try {
    imported = await importer(dependencies.kernelEntrypoint.href);
  } catch (cause) {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_UNAVAILABLE",
      `Could not load exact kernel package ${dependencies.manifest.kernel.packageName}`,
      { cause },
    );
  }
  const module = requiredRecord(imported, "kernel package module");
  const packagedIdentity = validateArtifactKernelPackageIdentity(
    module.artifactKernelPackageIdentity,
    dependencies.target.target,
  );
  assertSameKernelPackageIdentity(packagedIdentity, dependencies.manifest.kernel);
  if (typeof module.loadArtifactKernelBinding !== "function") {
    incompatible("kernel package does not export loadArtifactKernelBinding()");
  }
  const candidate = await module.loadArtifactKernelBinding();
  return new ArtifactKernelRuntime(
    dependencies.target.kind,
    candidate,
    dependencies.manifest.kernel,
  );
}

type RawCollaborationSession = {
  authorTransaction(intent: Uint8Array, resolvedBase: Uint8Array): Uint8Array;
  applyCommitted(operation: Uint8Array): void;
  query(request: Uint8Array): Uint8Array;
  snapshot(): Uint8Array;
  frontier(): Uint8Array;
  stateHash(): string;
  revision(): bigint | number;
  fork(): RawCollaborationSession;
  close?(): void;
  dispose?(): void;
  free?(): void;
  isClosed?(): boolean;
  readonly closed?: boolean;
};

type RawCollaborationSessionConstructor = {
  create(namespace: Uint8Array): RawCollaborationSession;
  open(snapshot: Uint8Array): RawCollaborationSession;
};

type RawModalitySession = {
  applyCommands(commands: Uint8Array): Uint8Array;
  query(request: Uint8Array): Uint8Array;
  snapshot(): Uint8Array;
  stateHash(): string;
  revision(): bigint | number;
  fork(): RawModalitySession;
  close?(): void;
  dispose?(): void;
  free?(): void;
  isClosed?(): boolean;
  readonly closed?: boolean;
};

type RawModalitySessionConstructor = {
  create(namespace: Uint8Array): RawModalitySession;
  open(snapshot: Uint8Array): RawModalitySession;
};

type RawTextLayoutSession = {
  layout(request: Uint8Array): Uint8Array;
  close?(): void;
  dispose?(): void;
  free?(): void;
  isClosed?(): boolean;
  readonly closed?: boolean;
};

type RawTextLayoutSessionConstructor = {
  open(fontBundle: Uint8Array): RawTextLayoutSession;
};

type RawArtifactKernelBinding = {
  capabilities(): Uint8Array;
  buildIdentity(): Uint8Array;
  createDocument(namespace: Uint8Array): Uint8Array;
  applyDocumentCommands(snapshot: Uint8Array, commands: Uint8Array): Uint8Array;
  queryDocument(snapshot: Uint8Array, query: Uint8Array): Uint8Array;
  canonicalizeDocumentSnapshot(snapshot: Uint8Array): Uint8Array;
  createPresentation(namespace: Uint8Array): Uint8Array;
  applyPresentationCommands(snapshot: Uint8Array, commands: Uint8Array): Uint8Array;
  queryPresentation(snapshot: Uint8Array, query: Uint8Array): Uint8Array;
  canonicalizePresentationSnapshot(snapshot: Uint8Array): Uint8Array;
  layoutText(fontBundle: Uint8Array, request: Uint8Array): Uint8Array;
  canonicalizeRenderTile(value: Uint8Array): Uint8Array;
  canonicalizeRenderPatch(value: Uint8Array): Uint8Array;
  canonicalizeCollaborationSnapshot(snapshot: Uint8Array): Uint8Array;
  ArtifactCollaborationSession: RawCollaborationSessionConstructor;
  ArtifactDocumentSession: RawModalitySessionConstructor;
  ArtifactPresentationSession: RawModalitySessionConstructor;
  ArtifactTextLayoutSession: RawTextLayoutSessionConstructor;
};

export class ArtifactKernelRuntime {
  readonly kind: ArtifactRuntimeKind;
  readonly target: ArtifactRuntimeTarget;
  readonly capabilities: ArtifactKernelCapabilities;
  readonly buildIdentity: string;
  readonly #binding: RawArtifactKernelBinding;

  constructor(
    kind: ArtifactRuntimeKind,
    candidate: unknown,
    packageManifest: ArtifactKernelPackageManifest,
  ) {
    const manifest = validateArtifactKernelPackageManifest(packageManifest);
    if (kind !== manifest.kind) incompatible("binding kind does not match package manifest");
    this.kind = kind;
    this.target = manifest.target;
    this.#binding = validateRawBinding(candidate);
    this.capabilities = parseCapabilities(this.#binding.capabilities());
    this.buildIdentity = decodeBuildIdentity(this.#binding.buildIdentity());
    if (this.buildIdentity !== manifest.buildIdentity) {
      throw new ArtifactRuntimeError(
        "ARTIFACT_RUNTIME_INTEGRITY",
        "Loaded kernel build identity does not match its package manifest",
      );
    }
  }

  canonicalizeCollaborationSnapshot(snapshot: Uint8Array): Uint8Array {
    return bytes(
      this.#binding.canonicalizeCollaborationSnapshot(snapshot),
      "canonicalizeCollaborationSnapshot",
    );
  }

  createDocument(namespace: bigint): Uint8Array {
    return bytes(
      this.#binding.createDocument(encodeArtifactReplicaNamespace(namespace)),
      "createDocument",
    );
  }

  applyDocumentCommands(snapshot: Uint8Array, commands: Uint8Array): Uint8Array {
    return bytes(this.#binding.applyDocumentCommands(snapshot, commands), "applyDocumentCommands");
  }

  queryDocument(snapshot: Uint8Array, query: Uint8Array): Uint8Array {
    return bytes(this.#binding.queryDocument(snapshot, query), "queryDocument");
  }

  canonicalizeDocumentSnapshot(snapshot: Uint8Array): Uint8Array {
    return bytes(
      this.#binding.canonicalizeDocumentSnapshot(snapshot),
      "canonicalizeDocumentSnapshot",
    );
  }

  createPresentation(namespace: bigint): Uint8Array {
    return bytes(
      this.#binding.createPresentation(encodeArtifactReplicaNamespace(namespace)),
      "createPresentation",
    );
  }

  applyPresentationCommands(snapshot: Uint8Array, commands: Uint8Array): Uint8Array {
    return bytes(
      this.#binding.applyPresentationCommands(snapshot, commands),
      "applyPresentationCommands",
    );
  }

  queryPresentation(snapshot: Uint8Array, query: Uint8Array): Uint8Array {
    return bytes(this.#binding.queryPresentation(snapshot, query), "queryPresentation");
  }

  canonicalizePresentationSnapshot(snapshot: Uint8Array): Uint8Array {
    return bytes(
      this.#binding.canonicalizePresentationSnapshot(snapshot),
      "canonicalizePresentationSnapshot",
    );
  }

  layoutText(fontBundle: Uint8Array, request: Uint8Array): Uint8Array {
    return bytes(this.#binding.layoutText(fontBundle, request), "layoutText");
  }

  canonicalizeRenderTile(value: Uint8Array): Uint8Array {
    return bytes(this.#binding.canonicalizeRenderTile(value), "canonicalizeRenderTile");
  }

  canonicalizeRenderPatch(value: Uint8Array): Uint8Array {
    return bytes(this.#binding.canonicalizeRenderPatch(value), "canonicalizeRenderPatch");
  }

  createCollaborationSession(namespace: bigint): ArtifactCollaborationSession {
    return new ArtifactCollaborationSession(
      this.#binding.ArtifactCollaborationSession.create(encodeArtifactReplicaNamespace(namespace)),
    );
  }

  openCollaborationSession(snapshot: Uint8Array): ArtifactCollaborationSession {
    return new ArtifactCollaborationSession(
      this.#binding.ArtifactCollaborationSession.open(snapshot),
    );
  }

  createDocumentSession(namespace: bigint): ArtifactDocumentSession {
    return new ArtifactDocumentSession(
      this.#binding.ArtifactDocumentSession.create(encodeArtifactReplicaNamespace(namespace)),
    );
  }

  openDocumentSession(snapshot: Uint8Array): ArtifactDocumentSession {
    return new ArtifactDocumentSession(this.#binding.ArtifactDocumentSession.open(snapshot));
  }

  createPresentationSession(namespace: bigint): ArtifactPresentationSession {
    return new ArtifactPresentationSession(
      this.#binding.ArtifactPresentationSession.create(encodeArtifactReplicaNamespace(namespace)),
    );
  }

  openPresentationSession(snapshot: Uint8Array): ArtifactPresentationSession {
    return new ArtifactPresentationSession(
      this.#binding.ArtifactPresentationSession.open(snapshot),
    );
  }

  openTextLayoutSession(fontBundle: Uint8Array): ArtifactTextLayoutSession {
    return new ArtifactTextLayoutSession(this.#binding.ArtifactTextLayoutSession.open(fontBundle));
  }
}

export class ArtifactCollaborationSession {
  readonly #session: RawCollaborationSession;
  #disposed = false;

  constructor(session: RawCollaborationSession) {
    validateRawCollaborationSession(session);
    this.#session = session;
  }

  authorTransaction(intent: Uint8Array, resolvedBase: Uint8Array): Uint8Array {
    this.assertLive();
    return bytes(this.#session.authorTransaction(intent, resolvedBase), "authorTransaction");
  }

  applyCommitted(operation: Uint8Array): void {
    this.assertLive();
    this.#session.applyCommitted(operation);
  }

  queryViewport(request: Uint8Array): Uint8Array {
    return this.query(request);
  }

  query(request: Uint8Array): Uint8Array {
    this.assertLive();
    return bytes(this.#session.query(request), "query");
  }

  snapshot(): Uint8Array {
    this.assertLive();
    return bytes(this.#session.snapshot(), "snapshot");
  }

  frontier(): Uint8Array {
    this.assertLive();
    return bytes(this.#session.frontier(), "frontier");
  }

  stateHash(): string {
    this.assertLive();
    const returnedStateHash = this.#session.stateHash();
    if (!/^sha256:[0-9a-f]{64}$/u.test(returnedStateHash))
      incompatible("kernel returned invalid state hash");
    return returnedStateHash;
  }

  revision(): bigint {
    this.assertLive();
    const revision = this.#session.revision();
    if (typeof revision === "bigint") {
      if (revision < 0n) incompatible("kernel returned a negative revision");
      return revision;
    }
    if (!Number.isSafeInteger(revision) || revision < 0) {
      incompatible("kernel returned an unsafe revision");
    }
    return BigInt(revision);
  }

  fork(): ArtifactCollaborationSession {
    this.assertLive();
    return new ArtifactCollaborationSession(this.#session.fork());
  }

  isClosed(): boolean {
    return (
      this.#disposed ||
      (typeof this.#session.isClosed === "function"
        ? this.#session.isClosed()
        : this.#session.closed === true)
    );
  }

  dispose(): void {
    if (this.#disposed) return;
    try {
      if (!this.isClosed()) {
        if (typeof this.#session.dispose === "function") this.#session.dispose();
        else this.#session.close?.();
      }
    } finally {
      this.#session.free?.();
      this.#disposed = true;
    }
  }

  private assertLive(): void {
    if (this.isClosed()) incompatible("artifact collaboration session is closed");
  }
}

class ArtifactModalitySession {
  readonly #session: RawModalitySession;
  #disposed = false;

  constructor(session: RawModalitySession) {
    validateRawModalitySession(session);
    this.#session = session;
  }

  applyCommands(commands: Uint8Array): Uint8Array {
    this.assertLive();
    return bytes(this.#session.applyCommands(commands), "modality session applyCommands");
  }

  query(request: Uint8Array): Uint8Array {
    this.assertLive();
    return bytes(this.#session.query(request), "modality session query");
  }

  snapshot(): Uint8Array {
    this.assertLive();
    return bytes(this.#session.snapshot(), "modality session snapshot");
  }

  revision(): bigint {
    this.assertLive();
    return safeRevision(this.#session.revision());
  }

  stateHash(): string {
    this.assertLive();
    return stateHash(this.#session.stateHash());
  }

  isClosed(): boolean {
    return rawSessionClosed(this.#disposed, this.#session);
  }

  dispose(): void {
    if (this.#disposed) return;
    try {
      if (!this.isClosed()) {
        if (typeof this.#session.dispose === "function") this.#session.dispose();
        else this.#session.close?.();
      }
    } finally {
      this.#session.free?.();
      this.#disposed = true;
    }
  }

  protected forkRaw(): RawModalitySession {
    this.assertLive();
    return this.#session.fork();
  }

  private assertLive(): void {
    if (this.isClosed()) incompatible("artifact modality session is closed");
  }
}

/** Exact stateful N-API document session over OGADC/OGADQ/OGADOC bytes. */
export class ArtifactDocumentSession extends ArtifactModalitySession {
  fork(): ArtifactDocumentSession {
    return new ArtifactDocumentSession(this.forkRaw());
  }
}

/** Exact stateful N-API presentation session over OGAPC/OGAPQ/OGAPS bytes. */
export class ArtifactPresentationSession extends ArtifactModalitySession {
  fork(): ArtifactPresentationSession {
    return new ArtifactPresentationSession(this.forkRaw());
  }
}

/** Exact stateful N-API text-layout session with a retained validated font bundle. */
export class ArtifactTextLayoutSession {
  readonly #session: RawTextLayoutSession;
  #disposed = false;

  constructor(session: RawTextLayoutSession) {
    validateRawTextLayoutSession(session);
    this.#session = session;
  }

  layout(request: Uint8Array): Uint8Array {
    if (this.isClosed()) incompatible("artifact text-layout session is closed");
    return bytes(this.#session.layout(request), "text-layout session layout");
  }

  isClosed(): boolean {
    return rawSessionClosed(this.#disposed, this.#session);
  }

  dispose(): void {
    if (this.#disposed) return;
    try {
      if (!this.isClosed()) {
        if (typeof this.#session.dispose === "function") this.#session.dispose();
        else this.#session.close?.();
      }
    } finally {
      this.#session.free?.();
      this.#disposed = true;
    }
  }
}

function descriptor<
  const Target extends ArtifactRuntimeTarget,
  const Kind extends ArtifactRuntimeKind,
  const Platform extends ArtifactRuntimeTargetDescriptor["platform"],
  const Arch extends ArtifactRuntimeTargetDescriptor["arch"],
>(
  target: Target,
  kind: Kind,
  platform: Platform,
  arch: Arch,
  libc?: ArtifactRuntimeLibc,
): ArtifactRuntimeTargetDescriptor & {
  readonly target: Target;
  readonly kind: Kind;
  readonly platform: Platform;
  readonly arch: Arch;
} {
  return {
    target,
    kind,
    packageName: `@opengeni/artifact-kernel-${target}`,
    platform,
    arch,
    ...(libc ? { libc } : {}),
  };
}

function defaultModuleImporter(specifier: string): Promise<unknown> {
  return import(/* @vite-ignore */ specifier);
}

function validateRawBinding(value: unknown): RawArtifactKernelBinding {
  const binding = bindingRecord(value, "artifact kernel binding");
  for (const name of [
    "capabilities",
    "buildIdentity",
    "canonicalizeCollaborationSnapshot",
    "createDocument",
    "applyDocumentCommands",
    "queryDocument",
    "canonicalizeDocumentSnapshot",
    "createPresentation",
    "applyPresentationCommands",
    "queryPresentation",
    "canonicalizePresentationSnapshot",
    "layoutText",
    "canonicalizeRenderTile",
    "canonicalizeRenderPatch",
  ] as const) {
    if (typeof binding[name] !== "function") incompatible(`kernel binding is missing ${name}()`);
  }
  const session = bindingRecord(
    binding.ArtifactCollaborationSession,
    "ArtifactCollaborationSession",
  );
  if (typeof session.create !== "function" || typeof session.open !== "function") {
    incompatible("ArtifactCollaborationSession is missing create/open factories");
  }
  for (const name of ["ArtifactDocumentSession", "ArtifactPresentationSession"] as const) {
    const constructor = bindingRecord(binding[name], name);
    if (typeof constructor.create !== "function" || typeof constructor.open !== "function") {
      incompatible(`${name} is missing create/open factories`);
    }
  }
  const textLayout = bindingRecord(binding.ArtifactTextLayoutSession, "ArtifactTextLayoutSession");
  if (typeof textLayout.open !== "function") {
    incompatible("ArtifactTextLayoutSession is missing open() factory");
  }
  return value as RawArtifactKernelBinding;
}

function validateRawCollaborationSession(value: RawCollaborationSession): void {
  const session = bindingRecord(value, "artifact collaboration session");
  for (const name of [
    "authorTransaction",
    "applyCommitted",
    "query",
    "snapshot",
    "frontier",
    "stateHash",
    "revision",
    "fork",
  ] as const) {
    if (typeof session[name] !== "function")
      incompatible(`collaboration session is missing ${name}()`);
  }
}

function validateRawModalitySession(value: RawModalitySession): void {
  const session = bindingRecord(value, "artifact modality session");
  for (const name of [
    "applyCommands",
    "query",
    "snapshot",
    "stateHash",
    "revision",
    "fork",
  ] as const) {
    if (typeof session[name] !== "function") {
      incompatible(`artifact modality session is missing ${name}()`);
    }
  }
}

function validateRawTextLayoutSession(value: RawTextLayoutSession): void {
  const session = bindingRecord(value, "artifact text-layout session");
  if (typeof session.layout !== "function") {
    incompatible("artifact text-layout session is missing layout()");
  }
}

function parseCapabilities(value: unknown): ArtifactKernelCapabilities {
  const decoded = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes(value, "capabilities")),
  ) as unknown;
  const capabilities = requiredRecord(decoded, "artifact kernel capabilities");
  const required = {
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
    safeRust: true,
    sessionForks: true,
    statefulSessions: true,
    transport: "bounded-uint8array",
  } as const;
  for (const [name, expected] of Object.entries(required)) {
    if (capabilities[name] !== expected) incompatible(`kernel capability ${name} is incompatible`);
  }
  for (const name of [
    "maxCellsPerBatch",
    "maxCommandBytes",
    "maxCommands",
    "maxCommittedTransactionBytes",
    "maxDocumentCommandBytes",
    "maxDocumentCommands",
    "maxDocumentQueryBytes",
    "maxDocumentQueryResponseBytes",
    "maxDocumentSnapshotBytes",
    "maxIntentBytes",
    "maxMetadataScannedCells",
    "maxMetadataSheets",
    "maxPresentationCommandBytes",
    "maxPresentationQueryBytes",
    "maxPresentationResponseBytes",
    "maxPresentationSnapshotBytes",
    "maxQueryBytes",
    "maxQueryResponseBytes",
    "maxSnapshotBytes",
    "maxSpreadsheetCommandBytes",
    "maxTextLayoutFontBundleBytes",
    "maxTextLayoutRequestBytes",
    "maxTextLayoutResponseBytes",
    "maxViewportArea",
    "maxViewportCells",
  ] as const) {
    positiveSafeInteger(capabilities[name], `kernel capability ${name}`);
  }
  return capabilities as ArtifactKernelCapabilities;
}

function decodeBuildIdentity(value: unknown): string {
  const identity = new TextDecoder("utf-8", { fatal: true }).decode(bytes(value, "buildIdentity"));
  return boundedString(identity, "kernel build identity", 512);
}

function safeRevision(value: bigint | number): bigint {
  if (typeof value === "bigint") {
    if (value < 0n) incompatible("kernel returned a negative revision");
    return value;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    incompatible("kernel returned an unsafe revision");
  }
  return BigInt(value);
}

function stateHash(value: string): string {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) incompatible("kernel returned invalid state hash");
  return value;
}

function rawSessionClosed(
  disposed: boolean,
  session: {
    isClosed?(): boolean;
    readonly closed?: boolean;
  },
): boolean {
  return (
    disposed ||
    (typeof session.isClosed === "function" ? session.isClosed() : session.closed === true)
  );
}

export function encodeArtifactReplicaNamespace(namespace: bigint): Uint8Array {
  if (namespace <= 0n || namespace > 0xffff_ffff_ffff_ffffn) {
    incompatible("artifact replica namespace must be a nonzero u64");
  }
  const envelope = new Uint8Array(28);
  envelope.set(new TextEncoder().encode("OGAKN001"));
  const view = new DataView(envelope.buffer);
  view.setUint16(8, 1, true);
  view.setBigUint64(12, namespace, true);
  view.setBigUint64(20, fnv64(envelope.subarray(0, 20)), true);
  return envelope;
}

function fnv64(value: Uint8Array): bigint {
  let hash = 0xcbf29ce484222325n;
  for (const byte of value) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash;
}

function assertSameKernelPackageIdentity(
  actual: ArtifactKernelPackageIdentity,
  expected: ArtifactKernelPackageManifest,
): void {
  if (
    JSON.stringify(actual) !==
    JSON.stringify({
      schemaVersion: expected.schemaVersion,
      target: expected.target,
      kind: expected.kind,
      packageName: expected.packageName,
      packageVersion: expected.packageVersion,
      artifactToolVersion: expected.artifactToolVersion,
      buildIdentity: expected.buildIdentity,
    })
  ) {
    throw new ArtifactRuntimeError(
      "ARTIFACT_RUNTIME_INTEGRITY",
      "Loaded kernel package identity differs from the installation manifest",
    );
  }
}

function confinedUrl(root: URL, relativePath: string): URL {
  const candidate = new URL(relativePath, root);
  if (candidate.protocol !== "file:" || !candidate.href.startsWith(root.href)) {
    invalid("runtime dependency escapes the installation root");
  }
  return candidate;
}

function safeRelativePath(value: unknown, name: string): string {
  const path = boundedString(value, name, 1024);
  if (
    path.startsWith("/") ||
    path.startsWith("\\") ||
    path.includes("\\") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..") ||
    /[%?#\0]/u.test(path)
  ) {
    invalid(`${name} must be a normalized relative POSIX path`);
  }
  return path;
}

function exactStableVersion(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(value)
  ) {
    invalid(`${name} must be an exact stable semantic version`);
  }
  return value;
}

function sha256(value: unknown, name: string): `sha256:${string}` {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    invalid(`${name} must be a lowercase SHA-256 digest`);
  }
  return value as `sha256:${string}`;
}

function sha512Integrity(value: unknown, name: string): `sha512-${string}` {
  if (typeof value !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    invalid(`${name} is invalid`);
  }
  return value as `sha512-${string}`;
}

function positiveSafeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) invalid(`${name} must be positive`);
  return value as number;
}

function boundedString(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    invalid(`${name} is invalid`);
  }
  return value;
}

function isArtifactRuntimeTarget(value: unknown): value is ArtifactRuntimeTarget {
  return (
    typeof value === "string" && (ARTIFACT_RUNTIME_TARGETS as readonly string[]).includes(value)
  );
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  name: string,
): Record<string, unknown> {
  const record = requiredRecord(value, name);
  const actualKeys = Object.keys(record).sort();
  const expectedKeys = [...keys].sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys))
    invalid(`${name} has unexpected fields`);
  return record;
}

function requiredRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    invalid(`${name} is invalid`);
  return value as Record<string, unknown>;
}

function bindingRecord(value: unknown, name: string): Record<string, unknown> {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    incompatible(`${name} is invalid`);
  }
  return value as Record<string, unknown>;
}

function bytes(value: unknown, name: string): Uint8Array {
  if (!(value instanceof Uint8Array)) incompatible(`kernel ${name} did not return Uint8Array`);
  return value;
}

function invalid(message: string): never {
  throw new ArtifactRuntimeError("ARTIFACT_RUNTIME_MANIFEST_INVALID", message);
}

function incompatible(message: string): never {
  throw new ArtifactRuntimeError("ARTIFACT_RUNTIME_INCOMPATIBLE", message);
}

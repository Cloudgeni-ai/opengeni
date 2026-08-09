import { type ArtifactRuntimeTarget } from "../../src/runtime";
export declare const ARTIFACT_KERNEL_BUILD_RECEIPT = "artifact-kernel-build-receipt.json";
export type ArtifactKernelBuildReceipt = Readonly<{
    schemaVersion: 1;
    producer: "opengeni-artifact-kernel-smoke-v1";
    target: ArtifactRuntimeTarget;
    kind: "native" | "wasm";
    buildIdentity: string;
    capabilities: Readonly<{
        bytes: number;
        sha256: `sha256:${string}`;
    }>;
    runtimeFiles: readonly Readonly<{
        path: string;
        bytes: number;
        sha256: `sha256:${string}`;
    }>[];
}>;
/** Runs the actual target binding and returns a deterministic build receipt. */
export declare function createArtifactKernelBuildReceipt(target: ArtifactRuntimeTarget, assetRoot: string): Promise<ArtifactKernelBuildReceipt>;
export declare function writeArtifactKernelBuildReceipt(target: ArtifactRuntimeTarget, assetRoot: string): Promise<string>;
export declare function readArtifactKernelBuildReceipt(target: ArtifactRuntimeTarget, assetRoot: string): Promise<ArtifactKernelBuildReceipt>;
export declare function validateArtifactKernelBuildReceipt(value: unknown, expectedTarget?: ArtifactRuntimeTarget): ArtifactKernelBuildReceipt;
export declare function canonicalArtifactKernelBuildReceiptBytes(value: unknown): Uint8Array;
export declare function artifactKernelTargetAssetDirectory(target: ArtifactRuntimeTarget, assetRoot: string): string;

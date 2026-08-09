export const artifactKernelRuntimeIdentity = Object.freeze({"schemaVersion":1,"target":"wasm-web","modality":"document","packageName":"@opengeni/artifact-kernel-wasm-document","packageVersion":"0.0.0","artifactToolVersion":"0.0.0","buildIdentity":"opengeni-artifact-kernel/0.1.0;abi=1;command=1;query=1;snapshot=1;document-snapshot=1;document-command=1;document-query=1;presentation-snapshot=1;presentation-command=1;presentation-query=1;text-layout-fonts=1;text-layout-request=1;text-layout-response=1;render-tile=1;render-patch=1;source=d55bdb2e773e8dd6009624f0fcc41e9060a7b2b61dede178c8e8d2ace47814be;toolchain=1367261bf04dd2fc4b2c6aa0ef397c21659ee1c973a9d98dcb8d84b46d68b06f","kernelVersion":"opengeni-artifact-kernel/0.1.0;abi=1;command=1;query=1;snapshot=1;document-snapshot=1;document-command=1;document-query=1;presentation-snapshot=1;presentation-command=1;presentation-query=1;text-layout-fonts=1;text-layout-request=1;text-layout-response=1;render-tile=1;render-patch=1;source=d55bdb2e773e8dd6009624f0fcc41e9060a7b2b61dede178c8e8d2ace47814be;toolchain=1367261bf04dd2fc4b2c6aa0ef397c21659ee1c973a9d98dcb8d84b46d68b06f","abiVersion":1,"protocolVersion":1,"modelSchemaVersion":1,"commandVersion":1});
export const artifactKernelPackageIdentity = artifactKernelRuntimeIdentity;
export const editableArtifactKernelAssets = Object.freeze({
  modality: "document",
  wasmGlueUrl: new URL("./artifact_kernel_document.js", import.meta.url),
  wasmBinaryUrl: new URL("./artifact_kernel_document_bg.wasm", import.meta.url),
});
export const editableArtifactKernelRuntime = Object.freeze({
  ...editableArtifactKernelAssets,
  kernelVersion: artifactKernelRuntimeIdentity.kernelVersion,
  protocolVersion: artifactKernelRuntimeIdentity.protocolVersion,
  modelSchemaVersion: artifactKernelRuntimeIdentity.modelSchemaVersion,
  commandVersion: artifactKernelRuntimeIdentity.commandVersion,
});
let initialization;
export async function loadArtifactKernelBinding() {
  initialization ??= (async () => {
    const binding = await import(/* @vite-ignore */ editableArtifactKernelAssets.wasmGlueUrl.href);
    await binding.default({ module_or_path: editableArtifactKernelAssets.wasmBinaryUrl });
    return binding;
  })();
  return initialization;
}

export const artifactKernelRuntimeIdentity = Object.freeze({"schemaVersion":1,"target":"wasm-web","modality":"spreadsheet","packageName":"@opengeni/artifact-kernel-wasm-spreadsheet","packageVersion":"0.0.0","artifactToolVersion":"0.0.0","buildIdentity":"opengeni-artifact-kernel/0.1.0;abi=1;command=1;query=1;snapshot=1;document-snapshot=1;document-command=1;document-query=1;presentation-snapshot=1;presentation-command=1;presentation-query=1;text-layout-fonts=1;text-layout-request=1;text-layout-response=1;render-tile=1;render-patch=1;source=a9194d659991a0910e6f9f47510670b2857b927c2a1b818b13cf480521a986dd;toolchain=1367261bf04dd2fc4b2c6aa0ef397c21659ee1c973a9d98dcb8d84b46d68b06f","kernelVersion":"opengeni-artifact-kernel/0.1.0;abi=1;command=1;query=1;snapshot=1;document-snapshot=1;document-command=1;document-query=1;presentation-snapshot=1;presentation-command=1;presentation-query=1;text-layout-fonts=1;text-layout-request=1;text-layout-response=1;render-tile=1;render-patch=1;source=a9194d659991a0910e6f9f47510670b2857b927c2a1b818b13cf480521a986dd;toolchain=1367261bf04dd2fc4b2c6aa0ef397c21659ee1c973a9d98dcb8d84b46d68b06f","abiVersion":1,"protocolVersion":1,"modelSchemaVersion":1,"commandVersion":1});
export const artifactKernelPackageIdentity = artifactKernelRuntimeIdentity;
export const editableArtifactKernelAssets = Object.freeze({
  modality: "spreadsheet",
  wasmGlueUrl: new URL("./artifact_kernel_spreadsheet.js", import.meta.url),
  wasmBinaryUrl: new URL("./artifact_kernel_spreadsheet_bg.wasm", import.meta.url),
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

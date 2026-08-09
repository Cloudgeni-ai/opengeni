export default async function initialize(input) {
  if (input?.module_or_path !== "https://artifacts.test/kernel.wasm") {
    throw new Error("wrong wasm-bindgen initializer shape");
  }
}

export function buildIdentity() {
  return new TextEncoder().encode("worker-test-build");
}

export function capabilities() {
  return new TextEncoder().encode(
    '{"abiVersion":1,"buildIdentityFormat":"utf8","canonicalStateHash":"sha256:canonical-snapshot","collaboration":true,"collaborationSnapshotVersion":1,"commandSchemaVersion":1,"committedTransactionVersion":1,"document":true,"documentCommandVersion":1,"documentQueryResponseVersion":1,"documentQueryVersion":1,"documentReceiptVersion":1,"documentSnapshotVersion":1,"documentStatefulSessions":true,"editableArtifactIntentVersion":1,"kernelSnapshotVersion":1,"maxCellsPerBatch":500000,"maxCommandBytes":8388608,"maxCommands":10000,"maxCommittedTransactionBytes":8388608,"maxDocumentCommandBytes":8388608,"maxDocumentCommands":4096,"maxDocumentQueryBytes":256,"maxDocumentQueryResponseBytes":8388608,"maxDocumentSnapshotBytes":67108864,"maxIntentBytes":5242880,"maxMetadataScannedCells":4000000,"maxMetadataSheets":10000,"maxPresentationCommandBytes":4194304,"maxPresentationQueryBytes":96,"maxPresentationResponseBytes":8388608,"maxPresentationSnapshotBytes":67108864,"maxQueryBytes":68,"maxQueryResponseBytes":8388608,"maxSnapshotBytes":67108864,"maxSpreadsheetCommandBytes":4194304,"maxTextLayoutFontBundleBytes":50331648,"maxTextLayoutRequestBytes":4194304,"maxTextLayoutResponseBytes":33554432,"maxViewportArea":1048576,"maxViewportCells":262144,"presentation":true,"presentationCommandVersion":1,"presentationQueryResponseVersion":1,"presentationQueryVersion":1,"presentationSnapshotVersion":1,"presentationStatefulSessions":true,"queryResponseVersion":1,"queryVersion":1,"receiptSchemaVersion":1,"retainedRenderPatchVersion":1,"retainedRenderTileVersion":1,"safeRust":true,"sessionForks":true,"spreadsheetCommandVersion":1,"statefulSessions":true,"textLayout":true,"textLayoutFontBundleVersion":1,"textLayoutRequestVersion":1,"textLayoutResponseVersion":1,"textLayoutStatefulSessions":true,"transport":"bounded-uint8array","workbookMetadataQueries":true}',
  );
}

export function canonicalizeCollaborationSnapshot(bytes) {
  return bytes.slice();
}

export function canonicalizeDocumentSnapshot(bytes) {
  return bytes.slice();
}

export function canonicalizePresentationSnapshot(bytes) {
  return bytes.slice();
}

export const ArtifactCollaborationSession = {
  open() {
    throw new Error("not used");
  },
};

export const ArtifactDocumentSession = {
  open() {
    throw new Error("not used");
  },
};

export const ArtifactPresentationSession = {
  open() {
    throw new Error("not used");
  },
};

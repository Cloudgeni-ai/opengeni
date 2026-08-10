import initialize, {
  ArtifactDocumentSession,
  buildIdentity,
  canonicalizeDocumentSnapshot,
  capabilities as fullCapabilities,
} from "./wasm-glue.mjs";

export default initialize;
export { ArtifactDocumentSession, buildIdentity, canonicalizeDocumentSnapshot };

export function capabilities() {
  const capability = JSON.parse(new TextDecoder().decode(fullCapabilities()));
  capability.collaboration = false;
  capability.presentation = false;
  capability.presentationStatefulSessions = false;
  capability.textLayout = false;
  capability.textLayoutStatefulSessions = false;
  capability.workbookMetadataQueries = false;
  return new TextEncoder().encode(JSON.stringify(capability));
}

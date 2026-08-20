/** Modality-specific durable semantic/schema versions. */
export const SPREADSHEET_ARTIFACT_MODEL_SCHEMA_VERSION = 2 as const;
export const DOCUMENT_ARTIFACT_MODEL_SCHEMA_VERSION = 1 as const;
export const PRESENTATION_ARTIFACT_MODEL_SCHEMA_VERSION = 1 as const;

/** Direct kernel workbook snapshot version (OGARTK02), never the durable CRDT snapshot. */
export const SPREADSHEET_KERNEL_SNAPSHOT_VERSION = 2 as const;

/** Modality-specific canonical snapshot versions. */
export const DOCUMENT_ARTIFACT_SNAPSHOT_VERSION = 1 as const;
export const PRESENTATION_ARTIFACT_SNAPSHOT_VERSION = 1 as const;

/** Canonical internal spreadsheet kernel command-envelope version. */
export const SPREADSHEET_KERNEL_COMMAND_VERSION = 2 as const;

/** Canonical public, identity-free spreadsheet command-envelope version. */
export const SPREADSHEET_ARTIFACT_COMMAND_VERSION = 2 as const;

/** Canonical durable spreadsheet collaboration-snapshot version. */
export const SPREADSHEET_COLLABORATION_SNAPSHOT_VERSION = 2 as const;

/** Canonical committed spreadsheet transaction protocol version. */
export const COMMITTED_TRANSACTION_PROTOCOL_VERSION = 2 as const;

/** Canonical document/presentation serialized-commit protocol version. */
export const EDITABLE_ARTIFACT_SERIALIZED_COMMIT_VERSION = 1 as const;

/** Canonical editable-artifact live transport protocol version. */
export const EDITABLE_ARTIFACT_LIVE_WIRE_VERSION = 2 as const;

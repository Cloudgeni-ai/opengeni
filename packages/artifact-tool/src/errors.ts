export type ArtifactFeatureArea =
  | "spreadsheet"
  | "presentation"
  | "document"
  | "codec"
  | "render"
  | "collaboration";

/** A requested feature cannot be represented faithfully by the active kernel. */
export class UnsupportedArtifactFeatureError extends Error {
  readonly name = "UnsupportedArtifactFeatureError";

  constructor(
    readonly area: ArtifactFeatureArea,
    readonly feature: string,
    readonly backend: string,
  ) {
    super(`${feature} is not supported by the ${backend} ${area} backend`);
  }
}

/** Artifact bytes or commands exceeded a declared safety/resource boundary. */
export class ArtifactLimitError extends Error {
  readonly name = "ArtifactLimitError";

  constructor(
    readonly limit: string,
    readonly actual: number,
    readonly maximum: number,
  ) {
    super(`${limit} exceeds the maximum (${actual} > ${maximum})`);
  }
}

/** A command's structural precondition no longer matches canonical state. */
export class ArtifactConflictError extends Error {
  readonly name = "ArtifactConflictError";

  constructor(
    message: string,
    readonly objectIds: readonly string[],
  ) {
    super(message);
  }
}

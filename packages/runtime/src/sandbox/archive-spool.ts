import type { TarWorkspaceArchiveDescriptor } from "@opengeni/contracts";

/** Process-owned, reopenable archive bytes. Never persisted as a local path. */
export type WorkspaceArchiveSpool = {
  path: string;
  byteSize: number;
  sha256: string;
  open: () => AsyncIterable<Uint8Array>;
  dispose: () => Promise<void>;
};

export type VerifiedHostWorkspaceArchive = {
  kind: "host_spool";
  spool: WorkspaceArchiveSpool;
  descriptor: TarWorkspaceArchiveDescriptor;
};

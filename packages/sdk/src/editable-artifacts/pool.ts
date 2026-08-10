import {
  createEditableArtifactSyncController,
  editableArtifactCacheNamespace,
  type CreateEditableArtifactSyncControllerOptions,
  type EditableArtifactSyncController,
} from "./controller";
import type { EditableArtifactId } from "./types";

export type EditableArtifactSyncLease = {
  controller: EditableArtifactSyncController;
  release: () => void;
};

export type EditableArtifactSyncControllerFactory = (
  artifactId: EditableArtifactId,
) => CreateEditableArtifactSyncControllerOptions;

/** Owns one ref-counted controller per exact auth/cache authority + artifact. */
export class EditableArtifactSyncPool {
  private readonly entries = new Map<
    string,
    {
      controller: EditableArtifactSyncController;
      references: number;
      retirementRevision: number;
    }
  >();

  constructor(private readonly optionsFor: EditableArtifactSyncControllerFactory) {}

  acquire(artifactId: EditableArtifactId): EditableArtifactSyncLease {
    // Resolve current authority on every acquisition. A pool may outlive one
    // login; artifact id alone is never sufficient cache/socket identity.
    const options = this.optionsFor(artifactId);
    const key = JSON.stringify([
      editableArtifactCacheNamespace(options.storageAuthority),
      artifactId,
    ]);
    let entry = this.entries.get(key);
    if (!entry) {
      const controller = createEditableArtifactSyncController(options);
      entry = { controller, references: 0, retirementRevision: 0 };
      this.entries.set(key, entry);
      controller.start();
    }
    entry.retirementRevision += 1;
    entry.references += 1;
    let released = false;
    return {
      controller: entry.controller,
      release: () => {
        if (released) return;
        released = true;
        const current = this.entries.get(key);
        if (!current || current.controller !== entry?.controller) return;
        current.references -= 1;
        if (current.references === 0) {
          const retirementRevision = ++current.retirementRevision;
          // React StrictMode and route transitions may release/reacquire in the
          // same task. Keep the one live controller through that handoff.
          queueMicrotask(() => {
            const latest = this.entries.get(key);
            if (
              latest !== current ||
              latest.references !== 0 ||
              latest.retirementRevision !== retirementRevision
            ) {
              return;
            }
            this.entries.delete(key);
            void latest.controller.close();
          });
        }
      },
    };
  }

  get size(): number {
    return this.entries.size;
  }
}

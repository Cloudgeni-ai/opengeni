import { ProviderRecoveryNotice } from "@opengeni/react";
import type { ModelRecovery } from "@/lib/model-recovery";

/** Live automatic-retry status above the composer; shared with embeds via `@opengeni/react`. */
export function ModelRecoveryNotice({ recovery }: { recovery: ModelRecovery }) {
  return (
    <div className="shrink-0 px-4 py-2 sm:px-6" data-model-recovery-notice="">
      <ProviderRecoveryNotice className="mx-auto w-full max-w-3xl" recovery={recovery} />
    </div>
  );
}

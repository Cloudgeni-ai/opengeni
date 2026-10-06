import { createHash } from "node:crypto";
import type { Database } from "@opengeni/db";
import { buildSandboxFileDownloadStep, type SandboxFileDownload } from "@opengeni/runtime";
import { JournalBindingError } from "@opengeni/runtime/sandbox";
import { executeSandboxV2SetupStep } from "./sandbox-v2-setup";
import type { SandboxV2TurnMachine } from "./sandbox-v2-turn";

export type SandboxV2FileDelivery = Pick<
  SandboxFileDownload,
  "fileId" | "mountPath" | "filename"
> & {
  sizeBytes: number;
  sha256: string;
};

/** Deliver a previously authorized immutable file. The host resolver must
 * recheck its ordinary resource grant before minting a URL; this helper grants
 * no file access. The retained step binds finalized size/hash and target path.
 * Refreshed signed URLs are resolved only at a fresh Start, off command text
 * and manifest. A replay recovers the original command; it never redownloads
 * after a completed step or replaces an uncertain side effect. */
export async function deliverSandboxV2File(
  db: Database,
  machine: SandboxV2TurnMachine,
  input: { setupId: string; file: SandboxV2FileDelivery },
  options: {
    resolveDownloadUrl: (file: SandboxV2FileDelivery) => Promise<string>;
    environment: () => Promise<Record<string, string>>;
    workspaceRoot?: string;
    signal?: AbortSignal;
    authorizeWrite?: () => Promise<void>;
  },
): Promise<void> {
  input = structuredClone(input);
  options = { ...options };
  if (
    !input.file.fileId ||
    input.file.fileId.length > 512 ||
    !Number.isSafeInteger(input.file.sizeBytes) ||
    input.file.sizeBytes < 0 ||
    typeof input.file.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(input.file.sha256)
  )
    throw new JournalBindingError("File delivery requires finalized immutable metadata");
  const urlVariable = "OPENGENI_ATTACHMENT_DOWNLOAD_URL";
  const workspaceRoot = options.workspaceRoot ?? "/workspace";
  const command = buildSandboxFileDownloadStep(input.file, workspaceRoot, {
    urlEnvironmentVariable: urlVariable,
  });
  const stepId = `file:${createHash("sha256").update(input.file.fileId).digest("hex")}`;
  await executeSandboxV2SetupStep(
    db,
    machine,
    { setupId: input.setupId, stepId, command },
    {
      workspaceRoot,
      prepareEnvironmentBeforeAllocation: true,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.authorizeWrite ? { authorizeWrite: options.authorizeWrite } : {}),
      environment: async () => {
        const url = await options.resolveDownloadUrl(structuredClone(input.file));
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          throw new JournalBindingError("Attachment URL is unavailable");
        }
        if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password)
          throw new JournalBindingError("Attachment URL is unavailable");
        return { ...(await options.environment()), [urlVariable]: url };
      },
    },
  );
}

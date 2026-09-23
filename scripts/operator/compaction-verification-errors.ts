import { compactionProviderFailureDiagnostics } from "../../packages/runtime/src/index";

/** Only fixed, locally authored assertion messages may bypass provider redaction. */
export class CompactionVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompactionVerificationError";
  }
}

export function verificationFailureDiagnostics(error: unknown): Record<string, unknown> {
  return {
    verificationFailed: true,
    ...(error instanceof CompactionVerificationError
      ? { message: error.message }
      : compactionProviderFailureDiagnostics(error)),
  };
}

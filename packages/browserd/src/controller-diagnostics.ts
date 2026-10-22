import {
  appendFileSync,
  fchmodSync,
  constants,
  closeSync,
  fstatSync,
  openSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { interactionDriverDiagnostic, redactInteractionDriverMessage } from "@opengeni/contracts";

/** Keep two bounded, owner-only diagnostic files even under a service manager
 * that discards stderr. The controller root is already private and owned. */
export function retainControllerDiagnostic(
  root: string,
  line: string,
  maxBytes = 1024 * 1024,
): void {
  const path = join(root, "controller-errors.jsonl");
  const bytes = Buffer.from(line);
  if (bytes.length > maxBytes) throw new Error("controller diagnostic exceeds file limit");
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  let rotate = false;
  try {
    if (!fstatSync(fd).isFile()) throw new Error("controller diagnostic is not a regular file");
    fchmodSync(fd, 0o600);
    rotate = fstatSync(fd).size + bytes.length > maxBytes;
    if (!rotate) appendFileSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
  if (rotate) {
    renameSync(path, `${path}.1`);
    const next = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      appendFileSync(next, bytes);
    } finally {
      closeSync(next);
    }
  }
}

/**
 * Log a dispatch error that no driver classified. The action's caller only sees
 * outcome_unknown, so without this line the cause of such a failure is lost.
 * Like request diagnostics it names the error class, the failing function and
 * the redacted head of its message; never page text or the action's values.
 */
export function reportUnexpectedDispatchError(
  resource: "browser" | "computer",
  error: unknown,
  command: unknown,
): void {
  const diagnostic = interactionDriverDiagnostic(error);
  const action = (command as { action?: { type?: unknown } | null } | null)?.action?.type;
  console.error(
    JSON.stringify({
      service: "opengeni-browserd",
      event: "unexpected_dispatch_error",
      resource,
      ...(typeof action === "string" && /^[a-z_]{1,32}$/u.test(action) ? { action } : {}),
      error: {
        name: diagnostic.errorClass,
        ...(diagnostic.frame ? { frame: diagnostic.frame } : {}),
        message: error instanceof Error ? redactInteractionDriverMessage(error.message) : "",
      },
    }),
  );
}

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

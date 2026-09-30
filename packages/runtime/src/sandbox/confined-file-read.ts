/** Open every path component relative to an already-open directory. No symlink
 * is followed, and renaming/swapping a component cannot redirect the descriptor.
 * Python is part of the managed runtime; unsupported hosts fail closed. */
export function confinedFileReadScript(root: string, path: string, maxBytes: number): string {
  return [
    "import os, stat, base64, sys",
    `root = ${JSON.stringify(root)}`,
    `path = ${JSON.stringify(path)}`,
    `limit = ${maxBytes}`,
    "fds = []",
    "try:",
    "    if not root.startswith('/') or not hasattr(os, 'O_NOFOLLOW'): raise ValueError()",
    "    parts = root.split('/') + path.split('/')",
    "    if any(p == '..' for p in parts): raise ValueError()",
    "    parts = [p for p in parts if p not in ('', '.')]",
    "    if not parts: raise ValueError()",
    "    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)",
    "    fds.append(fd)",
    "    for part in parts[:-1]:",
    "        expected = os.stat(part, dir_fd=fd, follow_symlinks=False)",
    "        if not stat.S_ISDIR(expected.st_mode): raise ValueError()",
    "        fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)",
    "        fds.append(fd)",
    "        actual = os.fstat(fd)",
    "        if (expected.st_dev, expected.st_ino) != (actual.st_dev, actual.st_ino): raise ValueError()",
    "    expected = os.stat(parts[-1], dir_fd=fd, follow_symlinks=False)",
    "    if not stat.S_ISREG(expected.st_mode): raise ValueError()",
    "    fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)",
    "    fds.append(fd)",
    "    actual = os.fstat(fd)",
    "    if not stat.S_ISREG(actual.st_mode) or (expected.st_dev, expected.st_ino) != (actual.st_dev, actual.st_ino): raise ValueError()",
    "    chunks = []",
    "    remaining = limit",
    "    while remaining:",
    "        chunk = os.read(fd, min(remaining, 65536))",
    "        if not chunk: break",
    "        chunks.append(chunk)",
    "        remaining -= len(chunk)",
    "    sys.stdout.write('__OPENGENI_CONFINED_READ_OK__' + base64.b64encode(b''.join(chunks)).decode('ascii') + '__OPENGENI_CONFINED_READ_END__')",
    "except FileNotFoundError:",
    "    sys.exit(66)",
    "except (OSError, ValueError):",
    "    sys.exit(67)",
    "finally:",
    "    for fd in reversed(fds): os.close(fd)",
  ].join("\n");
}

export function parseConfinedFileRead(stdout: string, maxBytes: number): Uint8Array | null {
  if (stdout.length > Math.ceil((maxBytes * 4) / 3) + 128) return null;
  const match =
    /^__OPENGENI_CONFINED_READ_OK__([A-Za-z0-9+/]*={0,2})__OPENGENI_CONFINED_READ_END__$/u.exec(
      stdout.trim(),
    );
  if (!match) return null;
  const bytes = Buffer.from(match[1]!, "base64");
  return bytes.byteLength <= maxBytes && bytes.toString("base64") === match[1] ? bytes : null;
}

/** No shell/Python startup hooks or task-local module imports. Use a runtime
 * interpreter, never a task-owned PATH entry; absent support fails closed. */
export function confinedFileReadCommand(root: string, path: string, maxBytes: number): string {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const script = confinedFileReadScript(root, path, maxBytes);
  return `/usr/bin/env -u BASH_ENV /bin/bash --noprofile --norc -c ${quote(
    `exec /usr/bin/env -i PATH=/usr/bin:/bin:/usr/local/bin python3 -I -S -c ${quote(script)}`,
  )}`;
}

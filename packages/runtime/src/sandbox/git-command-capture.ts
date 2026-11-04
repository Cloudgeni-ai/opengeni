/** Bounded Git transport backed by one private producer result. All spool
 * operations use no-follow directory descriptors, including cleanup. */
export function gitCommandCapture(input: {
  name: string;
  action: "capture" | "read" | "cleanup";
  command?: string;
  maxBytes?: number;
  chunkBytes: number;
  identity?: string;
  sizeBytes?: number;
  sha256?: string;
  offset?: number;
  expected?: number;
}): string {
  const script = [
    "import os, stat, sys, subprocess, hashlib, base64, json, signal",
    `request = json.loads(${JSON.stringify(JSON.stringify(input))})`,
    // Cleanup owns no children. Bound it in the actual provider process so a
    // slow cleanup cannot strand a semantic timeout with physical work running.
    "if request['action'] == 'cleanup': signal.alarm(5)",
    "parent = directory = output = None",
    "keep = False",
    "def identity(fd):",
    "    info = os.fstat(fd)",
    "    return str(info.st_dev) + ':' + str(info.st_ino)",
    "def remove():",
    "    if directory is None: return",
    "    try: os.unlink('output', dir_fd=directory)",
    "    except FileNotFoundError: pass",
    "    try:",
    "        current = os.stat(request['name'], dir_fd=parent, follow_symlinks=False)",
    "        if str(current.st_dev) + ':' + str(current.st_ino) == identity(directory): os.rmdir(request['name'], dir_fd=parent)",
    "    except FileNotFoundError: pass",
    "try:",
    "    root = os.path.realpath(os.environ.get('TMPDIR') or '/tmp')",
    "    parent = os.open(root, os.O_RDONLY | os.O_DIRECTORY)",
    "    if request['action'] == 'capture': os.mkdir(request['name'], 0o700, dir_fd=parent)",
    "    directory = os.open(request['name'], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)",
    "    if request['action'] != 'capture' and identity(directory) != request['identity']:",
    "        os.close(directory); directory = None; raise ValueError('capture identity changed')",
    "    if request['action'] == 'cleanup':",
    "        remove()",
    "    else:",
    "        if request['action'] == 'capture':",
    "            output = os.open('output', os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)",
    "            result = subprocess.run(['/bin/bash', '--noprofile', '--norc', '-c', request['command']], stdout=output, stderr=subprocess.DEVNULL)",
    "            os.fchmod(output, 0o400)",
    "        else:",
    "            output = os.open('output', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)",
    "        if not stat.S_ISREG(os.fstat(output).st_mode): raise ValueError('capture is not a file')",
    "        if request['action'] == 'capture':",
    "            os.lseek(output, 0, os.SEEK_SET)",
    "            digest = hashlib.sha256()",
    "            size = 0",
    "            while True:",
    "                block = os.read(output, 65536)",
    "                if not block: break",
    "                size += len(block); digest.update(block)",
    "            sha = digest.hexdigest()",
    "            status = result.returncode if result.returncode >= 0 else 128 - result.returncode",
    "            offset = 0",
    "            expected = min(size, request['chunkBytes']) if status == 0 and size <= request['maxBytes'] else 0",
    "            keep = status == 0 and request['chunkBytes'] < size <= request['maxBytes']",
    "            sys.stdout.write('__OPENGENI_GIT_SPOOL__' + identity(directory) + '\\n')",
    "        else:",
    "            keep = True",
    "            size, sha, status = request['sizeBytes'], request['sha256'], 0",
    "            offset, expected = request['offset'], request['expected']",
    "        os.lseek(output, offset, os.SEEK_SET)",
    "        chunks = []",
    "        remaining = expected",
    "        while remaining:",
    "            block = os.read(output, remaining)",
    "            if not block: break",
    "            chunks.append(block); remaining -= len(block)",
    "        sys.stdout.write('__OPENGENI_GIT_CHUNK_V1__\\t%d\\t%d\\t%s\\t%d\\t%d\\n' % (status, size, sha, offset, expected))",
    "        sys.stdout.write(base64.b64encode(b''.join(chunks)).decode('ascii'))",
    "        sys.stdout.write('\\n__OPENGENI_GIT_CHUNK_END_V1__')",
    "except (OSError, ValueError):",
    "    sys.exit(70)",
    "finally:",
    "    if output is not None: os.close(output)",
    "    if not keep and directory is not None: remove()",
    "    if directory is not None: os.close(directory)",
    "    if parent is not None: os.close(parent)",
  ].join("\n");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  // Find only a runtime interpreter, while retaining the provider environment
  // for the original Git producer (credentials, PATH wrappers and TMPDIR).
  return `opengeni_python=$(PATH=/usr/bin:/bin:/usr/local/bin:/run/current-system/sw/bin command -v python3) || exit 127; "$opengeni_python" -I -S -c ${quote(script)}`;
}

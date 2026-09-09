/** Runs inside the sandbox, not in a worker. No workspace files or provider
 * client objects are used as command identity. Python's standard library is
 * required; unsupported images fail before launching the user command. */
export const MODAL_COMMAND_RUNNER = String.raw`
import base64, codecs, errno, fcntl, json, os, pty, signal, socket, subprocess, sys, threading, time

request = json.loads(base64.b64decode(sys.argv[1]))
root = request.get("root", "/tmp/opengeni-command-journal-v1")
os.makedirs(root, mode=0o700, exist_ok=True)
if os.path.islink(root) or os.stat(root).st_uid != os.getuid():
    raise ValueError("unsafe command journal root")
if request["op"] == "allocate":
    key = request["key"]
    if len(key) != 64 or any(c not in "0123456789abcdef" for c in key):
        raise ValueError("invalid allocation key")
    with open(os.path.join(root, "allocate.lock"), "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        binding = os.path.join(root, "allocation-" + key)
        try:
            with open(binding) as file:
                handle, fingerprint = json.load(file)
            if fingerprint != request["fingerprint"]:
                raise ValueError("command identity mismatch")
        except FileNotFoundError:
            counter = os.path.join(root, "counter")
            try:
                with open(counter) as file:
                    handle = int(file.read()) + 1
            except FileNotFoundError:
                handle = 1073741824
            if handle > 2147483647:
                raise ValueError("command identity space exhausted")
            with open(counter + ".tmp", "w") as file:
                file.write(str(handle))
                file.flush()
                os.fsync(file.fileno())
            os.replace(counter + ".tmp", counter)
            with open(binding + ".tmp", "w") as file:
                json.dump([handle, request["fingerprint"]], file)
                file.flush()
                os.fsync(file.fileno())
            os.replace(binding + ".tmp", binding)
    print(json.dumps({"handle": handle}))
    sys.exit(0)
handle = request["handle"]
if not isinstance(handle, int) or isinstance(handle, bool) or not 1073741824 <= handle <= 2147483647:
    raise ValueError("command journal unavailable; completion is unknown")
directory = os.path.join(root, str(handle))

def atomic(name, value):
    temporary = os.path.join(directory, name + ".tmp")
    with open(temporary, "w") as file:
        json.dump(value, file)
        file.flush()
        os.fsync(file.fileno())
    os.replace(temporary, os.path.join(directory, name))

def process_identity(pid):
    try:
        with open("/proc/" + str(pid) + "/stat") as file:
            fields = file.read().rsplit(")", 1)[1].split()
        return None if fields[0] == "Z" else fields[19]
    except FileNotFoundError:
        return None

def status():
    try:
        with open(os.path.join(directory, "status")) as file:
            current = json.load(file)
        if current["state"] == "running" and process_identity(current["supervisor"]) != current["birth"]:
            # Re-read in case the supervisor recorded its terminal proof between
            # the first read and exiting. A dead tracker is not a child exit.
            with open(os.path.join(directory, "status")) as file:
                current = json.load(file)
            if current["state"] == "running":
                return {"state": "error", "error": "command supervisor unavailable; completion is unknown"}
        return current
    except FileNotFoundError:
        return None

def supervise(ready):
    os.setsid()
    null = os.open(os.devnull, os.O_RDWR)
    for fd in (0, 1, 2):
        os.dup2(null, fd)
    if null > 2:
        os.close(null)
    atomic("status", {"state": "running", "supervisor": os.getpid(), "birth": process_identity(os.getpid())})
    listener = socket.socket(socket.AF_UNIX)
    listener.bind(os.path.join(directory, "input.sock"))
    listener.listen(8)
    listener.settimeout(0.05)
    master = None
    child = None
    copy_errors = []
    try:
        args = request["args"]
        shell = args.get("shell") or "/bin/bash"
        command = [shell, "-lc" if args.get("login", True) else "-c", args["cmd"]]
        if args.get("runAs"):
            command = ["runuser", "-u", args["runAs"], "--"] + command
        if args.get("tty"):
            master, slave = pty.openpty()
            def terminal_session():
                os.setsid()
                import termios
                fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
            child = subprocess.Popen(command, cwd=args["workdir"], stdin=slave, stdout=slave,
                stderr=slave, preexec_fn=terminal_session, close_fds=True)
            os.close(slave)
            read_fd = master
        else:
            child = subprocess.Popen(command, cwd=args["workdir"], stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
            read_fd = child.stdout.fileno()
        def copy_output():
            try:
                with open(os.path.join(directory, "output"), "ab", buffering=0) as output:
                    while True:
                        try:
                            data = os.read(read_fd, 65536)
                        except OSError as error:
                            if error.errno == errno.EIO:
                                break
                            raise
                        if not data:
                            break
                        remaining = memoryview(data)
                        while remaining:
                            written = output.write(remaining)
                            if not written:
                                raise RuntimeError("command output write made no progress")
                            remaining = remaining[written:]
            except Exception as error:
                copy_errors.append(str(error))
        copier = threading.Thread(target=copy_output)
        copier.start()
        os.write(ready, b"1")
        os.close(ready)
        ready = None
        input_lock = threading.Lock()
        def deliver_input(connection):
            try:
                with connection:
                    connection.settimeout(5)
                    stream = connection.makefile("rb")
                    message = json.loads(stream.readline())
                    data = base64.b64decode(message["data"])
                    if data == b"\x03":
                        group = os.tcgetpgrp(master) if master is not None else child.pid
                        os.killpg(group, signal.SIGINT)
                    else:
                        with input_lock:
                            descriptor = master if master is not None else child.stdin.fileno()
                            remaining = memoryview(data)
                            while remaining:
                                remaining = remaining[os.write(descriptor, remaining):]
                    connection.sendall(b'{"ok":true}\n')
            except (OSError, ValueError):
                # A disconnected input caller cannot terminate command tracking.
                pass
        while child.poll() is None:
            try:
                connection, _ = listener.accept()
            except socket.timeout:
                continue
            # A child that never reads stdin must not block exit tracking or an
            # interrupt delivered by a separate caller. Input errors are unknown
            # outcomes, never permission to replay the write.
            threading.Thread(target=deliver_input, args=(connection,), daemon=True).start()
        code = child.wait()
        copier.join()
        if copy_errors:
            raise RuntimeError("command output capture failed: " + copy_errors[0])
        atomic("status", {"state": "exited", "exitCode": code if code >= 0 else 128 - code})
    except Exception as error:
        atomic("status", {"state": "error", "error": str(error)})
    finally:
        if ready is not None:
            os.close(ready)
        listener.close()
        if master is not None:
            os.close(master)
    os._exit(0)

if request["op"] == "start":
    try:
        os.mkdir(directory, mode=0o700)
        created = True
    except FileExistsError:
        created = False
    if created:
        atomic("identity", request["fingerprint"])
        open(os.path.join(directory, "output"), "xb").close()
        ready_read, ready_write = os.pipe()
        if os.fork() == 0:
            os.close(ready_read)
            supervise(ready_write)
        os.close(ready_write)
        try:
            if os.read(ready_read, 1) != b"1":
                raise RuntimeError("command supervisor startup failed; launch outcome is unknown")
        finally:
            os.close(ready_read)
    else:
        # A matching dispatch attaches, never launches again. Missing identity
        # (interrupted launch) and truncated numeric-ID collisions fail closed.
        with open(os.path.join(directory, "identity")) as file:
            if json.load(file) != request["fingerprint"]:
                raise ValueError("command identity mismatch")
elif not os.path.isdir(directory):
    raise ValueError("command journal unavailable; completion is unknown")

if request["op"] == "ack":
    with open(os.path.join(directory, "read.lock"), "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            with open(os.path.join(directory, "pending")) as file:
                pending = json.load(file)
        except FileNotFoundError:
            pending = None
        if pending == request["range"]:
            atomic("cursor", pending[1])
            os.unlink(os.path.join(directory, "pending"))
    print('{}')
    sys.exit(0)

data = request.get("chars", "")
if data:
    current = status()
    if current is None or current["state"] == "running":
        connection = socket.socket(socket.AF_UNIX)
        connection.settimeout(5)
        try:
            connection.connect(os.path.join(directory, "input.sock"))
            connection.sendall(json.dumps({"data": base64.b64encode(data.encode()).decode()}).encode() + b"\n")
            response = json.loads(connection.makefile("rb").readline())
            if not response.get("ok") and not response.get("completed"):
                raise ValueError("command input result unknown")
        except (ConnectionRefusedError, FileNotFoundError):
            if not status() or status()["state"] != "exited":
                raise
        finally:
            connection.close()

deadline = time.monotonic() + request.get("yieldMs", 250) / 1000
while time.monotonic() < deadline:
    current = status()
    if current and current["state"] != "running":
        break
    time.sleep(0.01)
current = status() or {"state": "error", "error": "command launch outcome is unknown"}
if current["state"] == "error":
    raise RuntimeError(current["error"])
# A pending page is immutable until its durable capture is acknowledged. Any
# reader can retry the same page after a transport failure or worker restart.
with open(os.path.join(directory, "read.lock"), "a") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    try:
        with open(os.path.join(directory, "pending")) as file:
            offset, end = json.load(file)
    except FileNotFoundError:
        try:
            with open(os.path.join(directory, "cursor")) as file:
                offset = json.load(file)
        except FileNotFoundError:
            offset = 0
        size = os.path.getsize(os.path.join(directory, "output"))
        end = min(size, offset + 65536)
        with open(os.path.join(directory, "output"), "rb") as file:
            file.seek(offset)
            decoder = codecs.getincrementaldecoder("utf8")(errors="replace")
            decoder.decode(file.read(end - offset), final=current["state"] == "exited" and end == size)
            end -= len(decoder.getstate()[0])
        if end > offset:
            atomic("pending", [offset, end])
    with open(os.path.join(directory, "output"), "rb") as file:
        file.seek(offset)
        output = file.read(end - offset)
    more = os.path.getsize(os.path.join(directory, "output")) > end
print(json.dumps({**current, "output": base64.b64encode(output).decode(), "range": [offset, end], "more": more}))
`;

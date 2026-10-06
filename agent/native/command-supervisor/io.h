/* Optional per-command I/O. No input bytes are persisted by this helper.
 * A surviving supervisor remembers acceptance; a replacement is never allowed.
 * Pipe writes are atomic (<= PIPE_BUF). PTY partial writes retain a RAM cursor.
 */
#include <inttypes.h>
#include <stdint.h>
#include <sys/ioctl.h>
#include <termios.h>

#define INPUT_BYTES 4096

enum io_mode { IO_NONE, IO_PIPE, IO_PTY };
struct command_io {
    enum io_mode mode;
    int input, reader, master, slave;
    int out_reader, err_reader, out_writer, err_writer;
    bool closed, failed, drained, capture;
    uint64_t accepted, pending;
    size_t length, offset;
    unsigned char bytes[INPUT_BYTES];
    char digest[65], last_digest[65];
};

static bool integer(const char *text, uint64_t *value) {
    if (!text[0] || (text[0] == '0' && text[1])) return false;
    for (const char *p = text; *p; p++) if (*p < '0' || *p > '9') return false;
    errno = 0;
    char *end;
    unsigned long long n = strtoull(text, &end, 10);
    if (errno || *end) return false;
    *value = (uint64_t)n;
    return true;
}

static void io_resize(struct command_io *io, unsigned short cols, unsigned short rows) {
    struct winsize size = {.ws_col = cols, .ws_row = rows};
    if (ioctl(io->master, TIOCSWINSZ, &size)) fail("terminal resize unavailable");
}

static void io_output_pipe(int *reader, int *writer) {
    int descriptors[2];
    if (pipe2(descriptors, O_CLOEXEC)) fail("output pipe unavailable");
    *reader = descriptors[0];
    *writer = descriptors[1];
    if (fcntl(*reader, F_SETFL, O_NONBLOCK)) fail("output pipe configuration failed");
}

static void io_open(struct command_io *io, enum io_mode mode, bool capture,
                    unsigned short cols, unsigned short rows) {
    memset(io, 0, sizeof(*io));
    io->mode = mode;
    io->input = io->reader = io->master = io->slave = -1;
    io->out_reader = io->err_reader = io->out_writer = io->err_writer = -1;
    io->capture = capture;
    if (capture && mode != IO_PTY) {
        io_output_pipe(&io->out_reader, &io->out_writer);
        io_output_pipe(&io->err_reader, &io->err_writer);
    }
    if (mode == IO_PIPE) {
        int descriptors[2];
        if (pipe2(descriptors, O_CLOEXEC)) fail("stdin pipe unavailable");
        io->reader = descriptors[0];
        io->input = descriptors[1];
        if (fpathconf(io->input, _PC_PIPE_BUF) < INPUT_BYTES) fail("atomic stdin pipe unavailable");
        if (fcntl(io->input, F_SETFL, O_NONBLOCK)) fail("stdin pipe configuration failed");
    } else if (mode == IO_PTY) {
        io->master = posix_openpt(O_RDWR | O_NOCTTY | O_CLOEXEC | O_NONBLOCK);
        if (io->master < 0 || grantpt(io->master) || unlockpt(io->master)) fail("terminal unavailable");
        char path[PATH_MAX];
        if (ptsname_r(io->master, path, sizeof(path))) fail("terminal path unavailable");
        io->slave = open(path, O_RDWR | O_NOCTTY | O_CLOEXEC);
        if (io->slave < 0) fail("terminal slave unavailable");
        io->input = io->master;
        io_resize(io, cols, rows);
    }
}

static void io_child(struct command_io *io) {
    if ((io->mode != IO_NONE || io->capture) && signal(SIGPIPE, SIG_DFL) == SIG_ERR)
        _exit(125);
    if (io->capture && io->mode != IO_PTY) {
        close(io->out_reader);
        close(io->err_reader);
        if (dup2(io->out_writer, STDOUT_FILENO) < 0 || dup2(io->err_writer, STDERR_FILENO) < 0) _exit(125);
        close(io->out_writer);
        close(io->err_writer);
    }
    if (io->mode == IO_PIPE) {
        close(io->input);
        if (dup2(io->reader, STDIN_FILENO) < 0) _exit(125);
        close(io->reader);
    } else if (io->mode == IO_PTY) {
        close(io->master);
        if (setsid() < 0 || ioctl(io->slave, TIOCSCTTY, 0)) _exit(125);
        for (int fd = 0; fd < 3; fd++) if (dup2(io->slave, fd) < 0) _exit(125);
        close(io->slave);
    }
}

static void io_parent(struct command_io *io) {
    if (io->reader >= 0) { close(io->reader); io->reader = -1; }
    if (io->slave >= 0) { close(io->slave); io->slave = -1; }
    if (io->out_writer >= 0) { close(io->out_writer); io->out_writer = -1; }
    if (io->err_writer >= 0) { close(io->err_writer); io->err_writer = -1; }
}

static void io_accept(struct command_io *io, uint64_t sequence, const char *digest) {
    io->accepted = sequence;
    memcpy(io->last_digest, digest, 65);
    io->pending = 0;
    io->length = io->offset = 0;
    memset(io->bytes, 0, sizeof(io->bytes));
}

static void io_flush_input(struct command_io *io) {
    if (!io->pending || io->failed) return;
    ssize_t n = write(io->input, io->bytes + io->offset, io->length - io->offset);
    if (n < 0) {
        if (errno == EINTR || errno == EAGAIN) return;
        io->failed = true;
        return;
    }
    if (n == 0) return;
    io->offset += (size_t)n;
    if (io->offset == io->length) io_accept(io, io->pending, io->digest);
}

static bool io_pump_stream(int source, int target) {
    /* Bound each pass so a busy terminal cannot starve cancellation/control. */
    for (int i = 0; i < 16; i++) {
        unsigned char buffer[8192];
        ssize_t n = read(source, buffer, sizeof(buffer));
        if (n == 0 || (n < 0 && errno == EIO)) return true;
        if (n < 0) {
            if (errno == EAGAIN) return false;
            if (errno == EINTR) continue;
            fail("command output unavailable");
        }
        ssize_t offset = 0;
        while (offset < n) {
            ssize_t written = write(target, buffer + offset, (size_t)(n - offset));
            if (written < 0 && errno == EINTR) continue;
            if (written <= 0) fail("command output persistence failed");
            offset += written;
        }
    }
    return false;
}

static void io_pump_output(struct command_io *io, bool terminal) {
    if (io->drained) return;
    if (io->mode == IO_PTY) {
        bool ended = io_pump_stream(io->master, STDOUT_FILENO);
        // Closing and later reopening a slave is valid while descendants live.
        // A temporary EIO/EOF becomes final only after kernel ECHILD.
        io->drained = terminal && ended;
    } else if (io->capture) {
        bool out_ended = io_pump_stream(io->out_reader, STDOUT_FILENO);
        bool err_ended = io_pump_stream(io->err_reader, STDERR_FILENO);
        io->drained = terminal && out_ended && err_ended;
    }
}

static int base64_digit(unsigned char value) {
    if (value >= 'A' && value <= 'Z') return value - 'A';
    if (value >= 'a' && value <= 'z') return value - 'a' + 26;
    if (value >= '0' && value <= '9') return value - '0' + 52;
    return value == '+' ? 62 : value == '/' ? 63 : -1;
}

static bool decode_input(const char *data, unsigned char bytes[INPUT_BYTES], size_t *length) {
    size_t size = strlen(data), count = 0;
    if (!size || size % 4 || size > ((INPUT_BYTES + 2) / 3) * 4) return false;
    for (size_t i = 0; i < size; i += 4) {
        int a = base64_digit((unsigned char)data[i]), b = base64_digit((unsigned char)data[i + 1]);
        int c = data[i + 2] == '=' ? 0 : base64_digit((unsigned char)data[i + 2]);
        int d = data[i + 3] == '=' ? 0 : base64_digit((unsigned char)data[i + 3]);
        bool pad2 = data[i + 2] == '=', pad1 = data[i + 3] == '=';
        if (a < 0 || b < 0 || c < 0 || d < 0 || (pad2 && !pad1) ||
            ((pad1 || pad2) && i + 4 != size) || (pad2 && (b & 15)) || (pad1 && !pad2 && (c & 3))) return false;
        unsigned char decoded[3] = {(unsigned char)((a << 2) | (b >> 4)),
            (unsigned char)((b << 4) | (c >> 2)), (unsigned char)((c << 6) | d)};
        size_t chunk = pad2 ? 1 : pad1 ? 2 : 3;
        if (count + chunk > INPUT_BYTES) return false;
        memcpy(bytes + count, decoded, chunk);
        count += chunk;
    }
    *length = count;
    return true;
}

static void io_reply(const struct command_io *io, uint64_t sequence, const char *status,
                     const char *reason, char response[FRAME_SIZE]) {
    snprintf(response, FRAME_SIZE,
        "{\"state\":\"input\",\"sequence\":%" PRIu64 ",\"acceptedThrough\":%" PRIu64
        ",\"status\":\"%s\",\"reason\":\"%s\",\"pendingSequence\":%" PRIu64 "}", sequence, io->accepted, status, reason, io->pending);
}

static void io_input(struct command_io *io, char *payload, bool started, bool quiescent, bool cancelled,
                     char response[FRAME_SIZE]) {
    char *parts[6], *position = payload;
    for (int i = 0; i < 6; i++) {
        parts[i] = strsep(&position, ":");
        if (!parts[i]) { strcpy(response, "{\"error\":\"invalid_input\"}"); return; }
    }
    uint64_t sequence, cols, rows;
    if (position || !integer(parts[0], &sequence) || !sequence || !hex(parts[2], 64) ||
        !integer(parts[3], &cols) || !integer(parts[4], &rows)) {
        strcpy(response, "{\"error\":\"invalid_input\"}"); return;
    }
    if (io->mode == IO_NONE) { io_reply(io, sequence, "rejected", "mode", response); return; }
    /* Older acknowledgements can replay after newer input. The journal verifies
     * each immutable request digest; this cumulative counter never writes twice. */
    if (sequence <= io->accepted) {
        io_reply(io, sequence, sequence == io->accepted && strcmp(parts[2], io->last_digest)
            ? "rejected" : "accepted", "retained", response);
        return;
    }
    if (quiescent || cancelled) {
        io_reply(io, sequence, io->pending == sequence && io->offset ? "unknown" : "rejected",
            cancelled ? "cancelled" : "terminal", response);
        return;
    }
    if (!started) { io_reply(io, sequence, "rejected", "not_started", response); return; }
    if (io->accepted == UINT64_MAX || sequence != io->accepted + 1) {
        io_reply(io, sequence, "rejected", "sequence", response); return;
    }
    if (io->pending) {
        if (strcmp(parts[2], io->digest)) { io_reply(io, sequence, "rejected", "conflict", response); return; }
        io_flush_input(io);
        io_reply(io, sequence, io->accepted >= sequence ? "accepted" : io->failed ? "unknown" : "pending", "retained", response);
        return;
    }
    if (!strcmp(parts[1], "data")) {
        if (cols || rows || io->closed || io->failed) { io_reply(io, sequence, "rejected", "closed", response); return; }
        size_t length;
        if (!decode_input(parts[5], io->bytes, &length)) { strcpy(response, "{\"error\":\"invalid_input\"}"); return; }
        io->pending = sequence;
        io->length = length;
        memcpy(io->digest, parts[2], 65);
        io_flush_input(io);
        io_reply(io, sequence, io->accepted >= sequence ? "accepted" : io->failed ? "unknown" : "pending", "delivery", response);
    } else if (!strcmp(parts[1], "close") && io->mode == IO_PIPE && !cols && !rows && !strcmp(parts[5], "-")) {
        if (!io->closed) { close(io->input); io->input = -1; io->closed = true; }
        io_accept(io, sequence, parts[2]);
        io_reply(io, sequence, "accepted", "closed", response);
    } else if (!strcmp(parts[1], "resize") && io->mode == IO_PTY && cols && rows &&
               cols <= 5000 && rows <= 5000 && !strcmp(parts[5], "-")) {
        io_resize(io, (unsigned short)cols, (unsigned short)rows);
        io_accept(io, sequence, parts[2]);
        io_reply(io, sequence, "accepted", "resized", response);
    } else strcpy(response, "{\"error\":\"invalid_input\"}");
}

static void io_close(struct command_io *io) {
    io_parent(io);
    if (io->master >= 0) close(io->master);
    else if (io->input >= 0) close(io->input);
    if (io->out_reader >= 0) close(io->out_reader);
    if (io->err_reader >= 0) close(io->err_reader);
    memset(io->bytes, 0, sizeof(io->bytes));
}

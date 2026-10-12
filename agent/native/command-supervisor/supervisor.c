/* Linux, single-threaded, per-invocation subreaper. Not a hostile-code boundary.
 * The control socket is never inherited by user code. Only kernel ECHILD after
 * launch has permanently closed authorizes a receipt; procfs is discovery only.
 */
#define _GNU_SOURCE
#include <elf.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/ioctl.h>
#include <sys/random.h>
#include <sys/signalfd.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

#define PROTOCOL "native-subreaper-v1"
#define PTY_PROTOCOL "native-subreaper-pty-v1"
#define FRAME_SIZE 1024
#define CANCEL_GRACE_MS 200
#define KEEPER_PROTOCOL "native-artifact-keeper-v1"
#define ARTIFACT_MAX_BYTES (256 * 1024)
#ifndef MFD_EXEC
#define MFD_EXEC 0x0010U
#endif
#ifndef MFD_ALLOW_SEALING
#define MFD_ALLOW_SEALING 0x0002U
#endif
#ifndef MFD_CLOEXEC
#define MFD_CLOEXEC 0x0001U
#endif
#define ARTIFACT_SEALS (F_SEAL_WRITE | F_SEAL_GROW | F_SEAL_SHRINK | F_SEAL_SEAL)

struct options {
    const char *invocation, *nonce, *path, *action, *receipt;
    char **command;
    bool launch, pty;
};

static const char *protocol(const struct options *o) {
    return o->pty ? PTY_PROTOCOL : PROTOCOL;
}

static void fail(const char *message) {
    /* Never include argv, nonce, command text or socket request in diagnostics. */
    fprintf(stderr, "command supervisor: %s (errno=%d)\n", message, errno);
    exit(125);
}

static bool hex(const char *s, size_t length) {
    if (strlen(s) != length) return false;
    for (size_t i = 0; i < length; i++)
        if (!((s[i] >= '0' && s[i] <= '9') || (s[i] >= 'a' && s[i] <= 'f')))
            return false;
    return true;
}

static bool uuid(const char *s) {
    if (strlen(s) != 36) return false;
    for (size_t i = 0; i < 36; i++) {
        if (i == 8 || i == 13 || i == 18 || i == 23) {
            if (s[i] != '-') return false;
        } else if (!((s[i] >= '0' && s[i] <= '9') || (s[i] >= 'a' && s[i] <= 'f')))
            return false;
    }
    return true;
}

struct artifact {
    size_t size;
    const char *target;
    int seals;
    uintmax_t device, inode;
};

static void read_exact_at(int fd, void *buffer, size_t size, off_t offset) {
    size_t filled = 0;
    while (filled < size) {
        ssize_t count = pread(fd, (char *)buffer + filled, size - filled,
            offset + (off_t)filled);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) fail("artifact read failed");
        filled += (size_t)count;
    }
}

static struct artifact inspect_artifact(int fd, bool sealed) {
    struct stat st;
    if (fstat(fd, &st) || !S_ISREG(st.st_mode) || st.st_size < (off_t)sizeof(Elf64_Ehdr) ||
        st.st_size > ARTIFACT_MAX_BYTES) fail("artifact size or type unsupported");
    Elf64_Ehdr header;
    read_exact_at(fd, &header, sizeof(header), 0);
    if (memcmp(header.e_ident, ELFMAG, SELFMAG) || header.e_ident[EI_CLASS] != ELFCLASS64 ||
        header.e_ident[EI_DATA] != ELFDATA2LSB || header.e_ident[EI_VERSION] != EV_CURRENT ||
        header.e_version != EV_CURRENT || header.e_type != ET_EXEC || !header.e_entry ||
        header.e_ehsize != sizeof(header) || header.e_phentsize != sizeof(Elf64_Phdr) ||
        !header.e_phnum || header.e_phnum > 64 || header.e_phoff < sizeof(header) ||
        header.e_phoff > (unsigned long long)st.st_size ||
        (unsigned long long)header.e_phnum * sizeof(Elf64_Phdr) >
            (unsigned long long)st.st_size - header.e_phoff)
        fail("artifact ELF unsupported");
    const char *target;
#if defined(__x86_64__)
    if (header.e_machine != EM_X86_64) fail("artifact target unsupported");
    target = "linux-amd64";
#elif defined(__aarch64__)
    if (header.e_machine != EM_AARCH64) fail("artifact target unsupported");
    target = "linux-arm64";
#else
#error "Native artifact keeper requires x86-64 or aarch64 Linux"
#endif
    unsigned int loads = 0;
    for (unsigned int i = 0; i < header.e_phnum; i++) {
        Elf64_Phdr segment;
        read_exact_at(fd, &segment, sizeof(segment), (off_t)(header.e_phoff + i * sizeof(segment)));
        if (segment.p_type == PT_INTERP || segment.p_type == PT_DYNAMIC)
            fail("artifact must be static");
        if (segment.p_type == PT_LOAD) {
            loads++;
            if (segment.p_filesz > segment.p_memsz || segment.p_offset > (unsigned long long)st.st_size ||
                segment.p_filesz > (unsigned long long)st.st_size - segment.p_offset)
                fail("artifact ELF segment unsupported");
        }
    }
    if (!loads) fail("artifact ELF has no load segment");
    int seals = fcntl(fd, F_GET_SEALS);
    if (sealed && (seals < 0 || (seals & ARTIFACT_SEALS) != ARTIFACT_SEALS ||
        !(st.st_mode & 0111))) fail("artifact seal proof unavailable");
    return (struct artifact){.size = (size_t)st.st_size, .target = target, .seals = seals,
        .device = (uintmax_t)st.st_dev, .inode = (uintmax_t)st.st_ino};
}

static int own_artifact(bool sealed, struct artifact *facts) {
    if (getuid() != 0 || geteuid() != 0) fail("artifact requires UID zero");
    /* This exact kernel-owned symlink identifies the executing inode even if
     * its original random pathname was replaced. Never follow a caller path. */
    int fd = open("/proc/self/exe", O_RDONLY | O_CLOEXEC);
    if (fd < 0) fail("own executable unavailable");
    *facts = inspect_artifact(fd, sealed);
    return fd;
}

static int sealed_artifact(struct artifact *facts) {
    int original = own_artifact(false, facts);
    int fd = (int)syscall(SYS_memfd_create, "opengeni-native-supervisor",
        MFD_CLOEXEC | MFD_ALLOW_SEALING | MFD_EXEC);
    /* Only unsupported flag syntax permits an old-kernel compatibility
     * attempt. Permission/policy denial never permits a different execution
     * path, chmod, dynamic loader or alternate unsealed file. */
    if (fd < 0 && errno == EINVAL)
        fd = (int)syscall(SYS_memfd_create, "opengeni-native-supervisor",
            MFD_CLOEXEC | MFD_ALLOW_SEALING);
    if (fd < 0) fail("executable memfd unavailable");
    unsigned char buffer[4096];
    for (size_t offset = 0; offset < facts->size;) {
        size_t size = facts->size - offset;
        if (size > sizeof(buffer)) size = sizeof(buffer);
        read_exact_at(original, buffer, size, (off_t)offset);
        size_t written = 0;
        while (written < size) {
            ssize_t count = write(fd, buffer + written, size - written);
            if (count < 0 && errno == EINTR) continue;
            if (count <= 0) fail("artifact copy failed");
            written += (size_t)count;
        }
        offset += size;
    }
    struct artifact after = inspect_artifact(original, false);
    close(original);
    if (after.size != facts->size) fail("own artifact changed");
    if (fcntl(fd, F_ADD_SEALS, ARTIFACT_SEALS)) fail("artifact seal failed");
    *facts = inspect_artifact(fd, true);
    return fd;
}

static int artifact_capability(bool bytes) {
    struct artifact facts;
    int fd = own_artifact(true, &facts);
    if (!bytes) {
        printf("{\"protocol\":\"%s\",\"byteSize\":%zu,\"seals\":%d,\"target\":\"%s\",\"static\":true,"
            "\"device\":\"%ju\",\"inode\":\"%ju\"}",
            KEEPER_PROTOCOL, facts.size, facts.seals, facts.target, facts.device, facts.inode);
    } else {
        static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        unsigned char input[3];
        for (size_t offset = 0; offset < facts.size; offset += 3) {
            size_t size = facts.size - offset;
            if (size > 3) size = 3;
            memset(input, 0, sizeof(input));
            read_exact_at(fd, input, size, (off_t)offset);
            char output[4] = {alphabet[input[0] >> 2],
                alphabet[((input[0] & 3) << 4) | (input[1] >> 4)],
                size > 1 ? alphabet[((input[1] & 15) << 2) | (input[2] >> 6)] : '=',
                size > 2 ? alphabet[input[2] & 63] : '='};
            if (fwrite(output, 1, sizeof(output), stdout) != sizeof(output))
                fail("artifact byte output unavailable");
        }
    }
    if (fflush(stdout) || ferror(stdout)) fail("artifact output unavailable");
    close(fd);
    return 0;
}

static int keeper(int argc, char **argv) {
    const char *source = NULL, *hash = NULL, *directory = NULL;
    for (int i = 2; i < argc; i += 2) {
        if (i + 1 >= argc) fail("keeper option value missing");
        const char **slot = NULL;
        if (!strcmp(argv[i], "--source-sha")) slot = &source;
        else if (!strcmp(argv[i], "--artifact-sha256")) slot = &hash;
        else if (!strcmp(argv[i], "--control-dir")) slot = &directory;
        else fail("unknown keeper option");
        if (*slot) fail("duplicate keeper option");
        *slot = argv[i + 1];
    }
    if (!source || !hex(source, 40) || !hash || !hex(hash, 64) || !directory ||
        strncmp(directory, "/.c", 3) || !hex(directory + 3, 64))
        fail("invalid keeper identity or root directory");
    struct artifact facts;
    int artifact = sealed_artifact(&facts);
    int root = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (root < 0) fail("root directory unavailable");
    if (mkdirat(root, directory + 1, 0700)) fail("keeper directory must be exclusive");
    int dir = openat(root, directory + 1, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    struct stat st;
    if (dir < 0 || fstat(dir, &st) || st.st_uid != 0 || (st.st_mode & 0777) != 0700)
        fail("keeper directory invalid");
    int marker = openat(dir, ".keeper", O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0400);
    if (marker < 0) fail("keeper marker must be exclusive");
    char record[768];
    int length = snprintf(record, sizeof(record),
        "{\"protocol\":\"%s\",\"state\":\"idle\",\"sourceSha\":\"%s\",\"artifactSha256\":\"%s\","
        "\"keeperPid\":%ld,\"artifactFd\":%d,\"seals\":%d,\"byteSize\":%zu,\"target\":\"%s\","
        "\"device\":\"%ju\",\"inode\":\"%ju\","
        "\"controlDirectory\":\"%s\",\"artifactPath\":\"/proc/%ld/fd/%d\"}\n",
        KEEPER_PROTOCOL, source, hash, (long)getpid(), artifact, facts.seals, facts.size,
        facts.target, facts.device, facts.inode, directory, (long)getpid(), artifact);
    if (length <= 0 || (size_t)length >= sizeof(record)) fail("keeper facts overflow");
    size_t written = 0;
    while (written < (size_t)length) {
        ssize_t count = write(marker, record + written, (size_t)length - written);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) fail("keeper facts write failed");
        written += (size_t)count;
    }
    sigset_t signals;
    sigemptyset(&signals);
    sigaddset(&signals, SIGTERM);
    struct sigaction ignored = {.sa_handler = SIG_IGN};
    sigemptyset(&ignored.sa_mask);
    if (sigaction(SIGINT, &ignored, NULL) || sigaction(SIGHUP, &ignored, NULL))
        fail("keeper terminal signal handling unavailable");
    struct sigaction default_term = {.sa_handler = SIG_DFL};
    sigemptyset(&default_term.sa_mask);
    if (sigaction(SIGTERM, &default_term, NULL)) fail("keeper termination signal reset failed");
    if (sigprocmask(SIG_BLOCK, &signals, NULL)) fail("keeper signal block failed");
    int events = signalfd(-1, &signals, SFD_CLOEXEC);
    if (events < 0) fail("keeper signal descriptor unavailable");
    /* No fork, subreaper, session/TTY change, or user command exists here.
     * Original declarations above are bindings, never self-attestation: the
     * host must hash artifact-bytes from the retained sealed FD before setup. */
    if (fwrite(record, 1, (size_t)length, stdout) != (size_t)length || fflush(stdout))
        fail("keeper facts output unavailable");
    struct signalfd_siginfo event;
    ssize_t count;
    do { count = read(events, &event, sizeof(event)); } while (count < 0 && errno == EINTR);
    if (count != (ssize_t)sizeof(event)) fail("keeper signal observation unavailable");
    close(events);
    close(artifact);
    struct stat marker_st, observed;
    if (!fstat(marker, &marker_st) && !fstatat(dir, ".keeper", &observed, AT_SYMLINK_NOFOLLOW) &&
        marker_st.st_dev == observed.st_dev && marker_st.st_ino == observed.st_ino)
        (void)unlinkat(dir, ".keeper", 0);
    close(marker);
    if (!fstatat(root, directory + 1, &observed, AT_SYMLINK_NOFOLLOW) &&
        st.st_dev == observed.st_dev && st.st_ino == observed.st_ino)
        (void)unlinkat(root, directory + 1, AT_REMOVEDIR); /* Empty only; never another invocation's sockets. */
    close(dir);
    close(root);
    return 0;
}

static struct options parse(int argc, char **argv) {
    struct options o = {0};
    if (argc < 2) fail("missing subcommand");
    o.launch = !strcmp(argv[1], "launch");
    if (!o.launch && strcmp(argv[1], "control")) fail("invalid subcommand");
    for (int i = 2; i < argc; i++) {
        if (!strcmp(argv[i], "--pty")) {
            if (o.pty) fail("duplicate PTY option");
            o.pty = true;
            continue;
        }
        if (!strcmp(argv[i], "--") && o.launch) {
            if (i + 1 == argc) fail("missing command");
            o.command = &argv[i + 1];
            break;
        }
        if (i + 1 == argc) fail("missing option value");
        const char **slot = NULL;
        if (!strcmp(argv[i], "--invocation")) slot = &o.invocation;
        else if (!strcmp(argv[i], "--nonce")) slot = &o.nonce;
        else if (!strcmp(argv[i], "--socket")) slot = &o.path;
        else if (!strcmp(argv[i], "--action")) slot = &o.action;
        else if (!strcmp(argv[i], "--receipt")) slot = &o.receipt;
        else fail("unknown option");
        if (*slot) fail("duplicate option");
        *slot = argv[++i];
    }
    if (!o.invocation || !uuid(o.invocation) || !o.nonce || !hex(o.nonce, 64) ||
        !o.path || o.path[0] != '/' || strlen(o.path) >= sizeof(((struct sockaddr_un *)0)->sun_path))
        fail("invalid identity or socket path");
    if (o.launch) {
        if (!o.command || o.action || o.receipt) fail("invalid launch options");
    } else {
        if (!o.action || (strcmp(o.action, "release") && strcmp(o.action, "cancel") &&
            strcmp(o.action, "status") && strcmp(o.action, "ack"))) fail("invalid action");
        if (!strcmp(o.action, "ack") ? (!o.receipt || !uuid(o.receipt)) : o.receipt != NULL)
            fail("invalid receipt option");
    }
    return o;
}

static long long milliseconds(void) {
    struct timespec t;
    if (clock_gettime(CLOCK_MONOTONIC, &t)) fail("clock unavailable");
    return (long long)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}

static int pidfd_open_child(pid_t pid) {
    int fd = (int)syscall(SYS_pidfd_open, pid, 0);
    if (fd < 0) fail("pidfd_open unavailable");
    return fd;
}

static void signal_handle(int fd, int signal_number) {
    if (syscall(SYS_pidfd_send_signal, fd, signal_number, NULL, 0) < 0 && errno != ESRCH)
        fail("pidfd signaling unavailable");
}

static void make_receipt_id(char out[37]) {
    unsigned char bytes[16];
    size_t filled = 0;
    while (filled < sizeof(bytes)) {
        ssize_t n = getrandom(bytes + filled, sizeof(bytes) - filled, 0);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) fail("receipt randomness unavailable");
        filled += (size_t)n;
    }
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    snprintf(out, 37, "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]);
}

static void signal_children(int signal_number) {
    /* A child cannot lose/reuse its PID while unreaped by this single thread.
     * Adoption may race this snapshot; subsequent passes discover those children.
     * There are no signal handlers, other threads, or other reapers here.
     */
    FILE *children = fopen("/proc/thread-self/children", "re");
    if (!children) fail("child discovery unavailable");
    int pid;
    int scanned;
    while ((scanned = fscanf(children, "%d", &pid)) == 1) {
        if (pid <= 0) fail("invalid child identity");
        int fd = pidfd_open_child(pid);
        signal_handle(fd, signal_number);
        close(fd);
    }
    if (scanned != EOF || ferror(children)) fail("child discovery failed");
    fclose(children);
}

static bool reap(pid_t leader, int *leader_exit, bool *leader_seen) {
    for (;;) {
        siginfo_t info = {0};
        if (waitid(P_ALL, 0, &info, WEXITED | WNOHANG | WNOWAIT | __WALL) < 0) {
            if (errno == EINTR) continue;
            if (errno != ECHILD) fail("all-child observation failed");
            /* No children remain to spawn/adopt. This final all-child wait is
             * the positive proof, never a procfs-empty snapshot or leader exit.
             */
            int status;
            pid_t result = waitpid(-1, &status, __WALL | WNOHANG);
            if (result != -1 || errno != ECHILD) fail("inconsistent all-child proof");
            return true;
        }
        if (!info.si_pid) return false;
        int fd = pidfd_open_child(info.si_pid); /* Before reaping, including clone children. */
        int status;
        pid_t result;
        do { result = waitpid(info.si_pid, &status, __WALL | WNOHANG); } while (result < 0 && errno == EINTR);
        close(fd);
        if (result != info.si_pid) fail("child reap failed");
        if (result == leader) {
            *leader_exit = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
            *leader_seen = true;
        }
    }
}

static struct sockaddr_un socket_address(const char *path) {
    struct sockaddr_un address = {.sun_family = AF_UNIX};
    memcpy(address.sun_path, path, strlen(path) + 1);
    return address;
}

static void validate_directory(const char *path, bool create) {
    char parent[PATH_MAX], resolved[PATH_MAX];
    strcpy(parent, path);
    char *slash = strrchr(parent, '/');
    if (!slash || slash == parent || !slash[1] || !strcmp(slash + 1, ".") || !strcmp(slash + 1, ".."))
        fail("invalid socket directory");
    *slash = 0;
    if (create && mkdir(parent, 0700) < 0 && errno != EEXIST) fail("socket directory creation failed");
    struct stat st;
    if (!realpath(parent, resolved) || lstat(parent, &st) || !S_ISDIR(st.st_mode) ||
        st.st_uid != geteuid() || (st.st_mode & 077) ||
        !strcmp(resolved, "/workspace") || !strncmp(resolved, "/workspace/", 11))
        fail("socket directory must be private and outside workspace");
}

static bool ready(int fd, short events, int timeout) {
    struct pollfd p = {.fd = fd, .events = events};
    int result;
    do { result = poll(&p, 1, timeout); } while (result < 0 && errno == EINTR);
    if (result < 0) fail("control poll failed");
    return result > 0 && (p.revents & events);
}

static ssize_t receive_frame(int fd, char buffer[FRAME_SIZE]) {
    ssize_t n = recv(fd, buffer, FRAME_SIZE - 1, MSG_TRUNC);
    if (n <= 0 || n >= FRAME_SIZE - 1 || memchr(buffer, 0, (size_t)n)) return -1;
    buffer[n] = 0;
    return n;
}

static void send_frame(int fd, const char *message) {
    /* Lost client/ACK response does not destroy the replayable receipt. */
    (void)send(fd, message, strlen(message), MSG_NOSIGNAL);
}

static int control(const struct options *o) {
    validate_directory(o->path, false);
    int fd = socket(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
    if (fd < 0) fail("control socket unavailable");
    struct sockaddr_un address = socket_address(o->path);
    if (connect(fd, (struct sockaddr *)&address, sizeof(address))) fail("control unavailable");
    char frame[FRAME_SIZE];
    snprintf(frame, sizeof(frame), "%s\t%s\t%s\t%s\t%s", protocol(o), o->invocation,
        o->nonce, o->action, o->receipt ? o->receipt : "-");
    if (send(fd, frame, strlen(frame), MSG_NOSIGNAL) != (ssize_t)strlen(frame)) fail("control send failed");
    if (!ready(fd, POLLIN, 2000) || receive_frame(fd, frame) < 0) fail("control response unavailable");
    close(fd);
    /* Only this trusted helper writes protocol JSON. Launch stdout is user data. */
    puts(frame);
    return strstr(frame, "\"error\"") ? 125 : 0;
}

static void initialize(void) {
    struct sigaction action = {.sa_handler = SIG_DFL};
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGCHLD, &action, NULL)) fail("SIGCHLD reset failed");
    sigset_t mask;
    sigemptyset(&mask);
    if (sigprocmask(SIG_SETMASK, &mask, NULL)) fail("signal mask reset failed");
    if (prctl(PR_SET_CHILD_SUBREAPER, 1)) fail("subreaper unavailable");
    int fd = pidfd_open_child(getpid());
    signal_handle(fd, 0);
    close(fd);
    int code = 0;
    bool seen = false;
    if (!reap(0, &code, &seen)) fail("unexpected inherited children");
    FILE *children = fopen("/proc/thread-self/children", "re");
    if (!children) fail("child discovery unavailable");
    fclose(children);
}

/* Use the provider's existing controlling terminal. Never steal it with
 * setsid/TIOCSCTTY, and never turn off the command's real shell job control.
 * A background or redirected wrapper cannot offer this PTY capability. */
static int inherited_terminal(void) {
    int terminal = open("/dev/tty", O_RDWR | O_NOCTTY | O_CLOEXEC);
    if (terminal < 0) fail("controlling terminal unavailable");
    unsigned int owned = 0, stream;
    bool device_identity = ioctl(terminal, TIOCGDEV, &owned) == 0;
    struct stat terminal_stat;
    if (!device_identity) {
        /* Some kernels expose /dev/tty as the actual terminal inode but do
         * not implement TIOCGDEV. Only ENOTTY permits this stricter proof:
         * every descriptor must name that same character-device inode.
         * A /dev/tty proxy with different inode metadata remains unsupported;
         * neither a session ID nor a pathname alone establishes identity. */
        if (errno != ENOTTY || fstat(terminal, &terminal_stat) ||
            !S_ISCHR(terminal_stat.st_mode)) fail("terminal identity unavailable");
    }
    for (int fd = 0; fd <= 2; fd++) {
        if (!isatty(fd)) fail("stdio must share controlling terminal");
        if (device_identity) {
            if (ioctl(fd, TIOCGDEV, &stream) || stream != owned)
                fail("stdio must share controlling terminal");
        } else {
            struct stat stream_stat;
            if (fstat(fd, &stream_stat) || !S_ISCHR(stream_stat.st_mode) ||
                stream_stat.st_dev != terminal_stat.st_dev ||
                stream_stat.st_ino != terminal_stat.st_ino ||
                stream_stat.st_rdev != terminal_stat.st_rdev)
                fail("stdio must share controlling terminal");
        }
        if (tcgetsid(fd) != getsid(0) || tcgetpgrp(fd) != getpgrp())
            fail("stdio must share controlling terminal");
    }
    if (tcgetsid(terminal) != getsid(0) || tcgetpgrp(terminal) != getpgrp())
        fail("controlling terminal must be foreground");
    struct termios attributes;
    /* Exercise handoff/restoration ioctls without changing foreground or mode,
     * so capability preflight fails on denied primitives before any launch. */
    if (tcgetattr(terminal, &attributes) || tcsetpgrp(terminal, getpgrp()) ||
        tcsetattr(terminal, TCSANOW, &attributes)) fail("terminal control unavailable");
    return terminal;
}

static void terminal_signals(void (*handler)(int)) {
    const int signals[] = {SIGHUP, SIGINT, SIGQUIT, SIGTSTP, SIGTTIN, SIGTTOU, SIGPIPE};
    struct sigaction action = {.sa_handler = handler};
    sigemptyset(&action.sa_mask);
    for (size_t i = 0; i < sizeof(signals) / sizeof(signals[0]); i++) {
        if (sigaction(signals[i], &action, NULL)) fail("terminal signal reset failed");
    }
}

static void child_signals(void) {
    terminal_signals(SIG_DFL);
    struct sigaction action = {.sa_handler = SIG_DFL};
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGTERM, &action, NULL) || sigaction(SIGCHLD, &action, NULL))
        _exit(125);
    sigset_t mask;
    sigemptyset(&mask);
    if (sigprocmask(SIG_SETMASK, &mask, NULL)) _exit(125);
}

static void barrier_write(int fd) {
    ssize_t n;
    do { n = write(fd, "+", 1); } while (n < 0 && errno == EINTR);
    if (n != 1) fail("terminal launch barrier failed");
}

static void barrier_read(int fd) {
    char byte;
    ssize_t n;
    do { n = read(fd, &byte, 1); } while (n < 0 && errno == EINTR);
    if (n != 1 || byte != '+') fail("terminal launch barrier failed");
}

struct launch_barrier {
    int prepared, release;
};

static void close_barrier(struct launch_barrier *barrier) {
    if (barrier->prepared >= 0) close(barrier->prepared);
    if (barrier->release >= 0) close(barrier->release);
    barrier->prepared = barrier->release = -1;
}

/* Readiness must never block the authenticated control loop. A stopped,
 * failed or externally signaled child remains owned and cancellable even
 * before exec. Closing release forbids user code on every handoff failure. */
static bool advance_barrier(struct launch_barrier *barrier, pid_t leader, int terminal) {
    if (barrier->prepared < 0) return true;
    char byte;
    ssize_t n;
    do { n = read(barrier->prepared, &byte, 1); } while (n < 0 && errno == EINTR);
    if (n < 0 && errno == EAGAIN) return true;
    bool prepared = n == 1 && byte == '+';
    if (prepared && getpgid(leader) == leader && !tcsetpgrp(terminal, leader) &&
        tcgetpgrp(terminal) == leader) {
        do { n = write(barrier->release, "+", 1); } while (n < 0 && errno == EINTR);
        prepared = n == 1;
    } else prepared = false;
    close_barrier(barrier);
    return prepared;
}

static pid_t start_command(const struct options *o, int listener, int client, int terminal,
                          struct launch_barrier *barrier) {
    int prepared[2] = {-1, -1}, release[2] = {-1, -1};
    if (o->pty && (pipe2(prepared, O_CLOEXEC) || pipe2(release, O_CLOEXEC)))
        fail("terminal launch barrier unavailable");
    if (o->pty && (fcntl(prepared[0], F_SETFL, O_NONBLOCK) ||
                  fcntl(release[1], F_SETFL, O_NONBLOCK)))
        fail("terminal readiness unavailable");
    pid_t leader = fork();
    if (leader < 0) fail("leader fork failed");
    if (!leader) {
        close(client);
        close(listener);
        if (o->pty) {
            close(terminal);
            close(prepared[0]);
            close(release[1]);
            /* Defaults are restored before handoff so Ctrl-C/Ctrl-Z cannot
             * disappear into inherited ignored dispositions at the barrier. */
            if (setpgid(0, 0)) _exit(125);
            child_signals();
            barrier_write(prepared[1]);
            close(prepared[1]);
            barrier_read(release[0]);
            close(release[0]);
        }
        execvp(o->command[0], o->command);
        _exit(127);
    }
    int handle = pidfd_open_child(leader);
    if (o->pty) {
        close(prepared[1]);
        close(release[0]);
        barrier->prepared = prepared[0];
        barrier->release = release[1];
    }
    close(handle);
    return leader;
}

static int launch(const struct options *o) {
    initialize(); /* All required primitives checked before any user code. */
    int terminal = o->pty ? inherited_terminal() : -1;
    pid_t foreground = o->pty ? getpgrp() : 0;
    struct termios attributes;
    if (o->pty) {
        if (tcgetattr(terminal, &attributes)) fail("terminal attributes unavailable");
        /* The supervisor must remain alive when a foreground job stops or
         * receives terminal signals. User children restore native defaults. */
        terminal_signals(SIG_IGN);
    }
    validate_directory(o->path, true);
    int listener = socket(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
    if (listener < 0) fail("control socket unavailable");
    struct sockaddr_un address = socket_address(o->path);
    mode_t previous = umask(0077);
    int bound = bind(listener, (struct sockaddr *)&address, sizeof(address));
    umask(previous);
    /* Never unlink an existing socket, including an earlier invocation. */
    if (bound || listen(listener, 16)) fail("control bind failed");
    bool started = false, cancelled = false, quiescent = false, leader_seen = false;
    pid_t leader = 0;
    struct launch_barrier barrier = {.prepared = -1, .release = -1};
    int leader_exit = 125; /* Cancelled before release: no leader was launched. */
    long long cancel_at = 0;
    char receipt_id[37], response[FRAME_SIZE];
    make_receipt_id(receipt_id);
    for (;;) {
        if (!quiescent && (started || cancelled)) {
            if (barrier.prepared >= 0) {
                if (cancelled) close_barrier(&barrier);
                else if (!advance_barrier(&barrier, leader, terminal)) {
                    cancelled = true;
                    cancel_at = milliseconds();
                }
            }
            if (cancelled) signal_children(milliseconds() - cancel_at < CANCEL_GRACE_MS ? SIGTERM : SIGKILL);
            if (reap(leader, &leader_exit, &leader_seen)) {
                if (started && !leader_seen) fail("leader status missing");
                if (o->pty && (tcsetpgrp(terminal, foreground) ||
                    tcsetattr(terminal, TCSANOW, &attributes)))
                    fail("terminal restoration failed");
                quiescent = true;
                snprintf(response, sizeof(response),
                    "{\"state\":\"quiescent\",\"receipt\":{\"protocol\":\"%s\",\"invocationId\":\"%s\","
                    "\"receiptId\":\"%s\",\"leaderExitCode\":%d}}", protocol(o), o->invocation, receipt_id, leader_exit);
            }
        }
        if (!ready(listener, POLLIN, 10)) continue;
        int client = accept4(listener, NULL, NULL, SOCK_CLOEXEC | SOCK_NONBLOCK);
        if (client < 0) {
            if (errno == EAGAIN || errno == EINTR) continue;
            fail("control accept failed");
        }
        char frame[FRAME_SIZE];
        bool ack = false;
        if (!ready(client, POLLIN, 100) || receive_frame(client, frame) < 0) {
            close(client);
            continue;
        }
        char *fields[5], *position = frame;
        bool valid = true;
        for (int i = 0; i < 5; i++) {
            fields[i] = strsep(&position, "\t");
            if (!fields[i]) valid = false;
        }
        valid = valid && !position && !strcmp(fields[0], protocol(o)) &&
            !strcmp(fields[1], o->invocation) && !strcmp(fields[2], o->nonce);
        if (!valid) {
            send_frame(client, "{\"error\":\"unauthenticated\"}");
        } else if (!strcmp(fields[3], "ack")) {
            ack = quiescent && !strcmp(fields[4], receipt_id);
            send_frame(client, ack ? response : "{\"error\":\"receipt_mismatch\"}");
        } else if (strcmp(fields[4], "-") || (strcmp(fields[3], "release") &&
            strcmp(fields[3], "cancel") && strcmp(fields[3], "status"))) {
            send_frame(client, "{\"error\":\"invalid_action\"}");
        } else {
            if (!strcmp(fields[3], "cancel") && !cancelled && !quiescent) {
                cancelled = true;
                cancel_at = milliseconds();
            }
            if (!strcmp(fields[3], "release") && !started && !cancelled && !quiescent) {
                leader = start_command(o, listener, client, terminal, &barrier);
                started = true;
            }
            send_frame(client, quiescent ? response :
                (started || cancelled ? "{\"state\":\"running\"}" : "{\"state\":\"idle\"}"));
        }
        close(client);
        if (ack) {
            close(listener);
            if (terminal >= 0) close(terminal);
            /* Control housekeeping only; never mutate /workspace after proof. */
            if (unlink(o->path)) fail("control cleanup failed");
            return 0;
        }
    }
}

/* Unlike retained commands, a placement service owns its descendants only
 * while its leader lives. Keep the subreaper alive through leader crashes and
 * terminate adopted descendants before exiting, including detached daemons. */
static int service(char **command) {
    initialize();
    sigset_t signals;
    sigemptyset(&signals);
    sigaddset(&signals, SIGTERM);
    sigaddset(&signals, SIGINT);
    sigaddset(&signals, SIGCHLD);
    if (sigprocmask(SIG_BLOCK, &signals, NULL)) fail("service signal block failed");
    struct sigaction action = {.sa_handler = SIG_DFL};
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGTERM, &action, NULL) || sigaction(SIGINT, &action, NULL))
        fail("service signal reset failed");
    int events = signalfd(-1, &signals, SFD_CLOEXEC | SFD_NONBLOCK);
    if (events < 0) fail("service signal descriptor unavailable");
    pid_t leader = fork();
    if (leader < 0) fail("service fork failed");
    if (!leader) {
        close(events);
        sigemptyset(&signals);
        if (sigprocmask(SIG_SETMASK, &signals, NULL)) _exit(125);
        execvp(command[0], command);
        _exit(127);
    }
    int handle = pidfd_open_child(leader);
    int code = 125;
    bool seen = false;
    long long shutdown_at = 0, cleanup_at = 0;
    for (;;) {
        if (reap(leader, &code, &seen)) {
            close(handle);
            close(events);
            return code;
        }
        long long now = milliseconds();
        if (seen || (shutdown_at && now - shutdown_at >= 30000)) {
            if (!cleanup_at) cleanup_at = now;
            signal_children(now - cleanup_at >= CANCEL_GRACE_MS ? SIGKILL : SIGTERM);
        }
        if (ready(events, POLLIN, cleanup_at ? 10 : 1000)) {
            struct signalfd_siginfo info;
            ssize_t size = read(events, &info, sizeof(info));
            if (size < 0 && (errno == EAGAIN || errno == EINTR)) continue;
            if (size != (ssize_t)sizeof(info)) fail("service signal read failed");
            if (info.ssi_signo == SIGCHLD) continue;
            if (!seen) signal_handle(handle, (int)info.ssi_signo);
            if (!shutdown_at) shutdown_at = milliseconds();
        }
    }
}

/* Bounded bootstrap qualification for the separately versioned broker route.
 * It runs only this sealed ELF's fixed inspection/capability modes, never a
 * caller command. The existing keeper and provider-path protocol are unchanged.
 * A successful probe is not a command receipt or permission to activate a broker.
 */
#define BROKER_PREFLIGHT_PROTOCOL "native-command-broker-preflight-v1"
#define BROKER_PROBE_MAX_BYTES (((ARTIFACT_MAX_BYTES + 2) / 3) * 4)
#define BROKER_CHUNK_BYTES 8192

static size_t broker_base64(const unsigned char *input, size_t size, char *output) {
    static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    size_t written = 0;
    for (size_t offset = 0; offset < size; offset += 3) {
        unsigned int a = input[offset];
        unsigned int b = offset + 1 < size ? input[offset + 1] : 0;
        unsigned int c = offset + 2 < size ? input[offset + 2] : 0;
        output[written++] = alphabet[a >> 2];
        output[written++] = alphabet[((a & 3) << 4) | (b >> 4)];
        output[written++] = offset + 1 < size ? alphabet[((b & 15) << 2) | (c >> 6)] : '=';
        output[written++] = offset + 2 < size ? alphabet[c & 63] : '=';
    }
    output[written] = 0;
    return written;
}

static void broker_probe_frame(const char *id, unsigned int sequence, const char *kind,
                               size_t offset, const unsigned char *payload, size_t size) {
    if (size > BROKER_CHUNK_BYTES) fail("broker probe frame exceeds bound");
    char encoded[((BROKER_CHUNK_BYTES + 2) / 3) * 4 + 1];
    (void)broker_base64(payload, size, encoded);
    if (printf("OGB1\tresponse\t%s\t1\t%u\t%s\t-\t%s\t%zu\t%zu\tbase64\t%s\n",
               id, sequence, id, kind, offset, size, encoded) < 0 || fflush(stdout))
        fail("broker probe output unavailable");
}

/* Child identity is pinned before it may exec. stdout/stderr are private and
 * bounded; nothing inherited from a provider TaskExec can impersonate proof.
 * The PTY case owns a NEW session and controlling terminal. This does not
 * modify launch's existing inherited-foreground-terminal contract.
 */
static size_t broker_probe_exec(int artifact, const char *mode, const char *argument,
                                bool pty, unsigned char *output, size_t capacity) {
    int channel[2] = {-1, -1}, barrier[2] = {-1, -1}, master = -1, slave = -1;
    if (pipe2(barrier, O_CLOEXEC)) fail("broker probe barrier unavailable");
    if (pty) {
        master = posix_openpt(O_RDWR | O_NOCTTY | O_CLOEXEC);
        if (master < 0 || grantpt(master) || unlockpt(master)) fail("broker probe PTY unavailable");
        char *name = ptsname(master);
        if (!name) fail("broker probe PTY identity unavailable");
        slave = open(name, O_RDWR | O_NOCTTY | O_CLOEXEC | O_NOFOLLOW);
        if (slave < 0) fail("broker probe PTY slave unavailable");
        channel[0] = master;
    } else if (pipe2(channel, O_CLOEXEC)) fail("broker probe output pipe unavailable");
    pid_t parent = getpid();
    pid_t child = fork();
    if (child < 0) fail("broker probe fork failed");
    if (!child) {
        close(barrier[1]);
        close(channel[0]);
        if (prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != parent) _exit(125);
        child_signals();
        char released;
        ssize_t received;
        do { received = read(barrier[0], &released, 1); } while (received < 0 && errno == EINTR);
        close(barrier[0]);
        if (received != 1 || released != '+') _exit(125);
        if (pty) {
            if (setsid() < 0 || ioctl(slave, TIOCSCTTY, 0) ||
                dup2(slave, STDIN_FILENO) < 0 || dup2(slave, STDOUT_FILENO) < 0 ||
                dup2(slave, STDERR_FILENO) < 0) _exit(125);
            if (slave > STDERR_FILENO) close(slave);
        } else {
            int input = open("/dev/null", O_RDONLY | O_CLOEXEC);
            if (input < 0 || dup2(input, STDIN_FILENO) < 0 ||
                dup2(channel[1], STDOUT_FILENO) < 0 || dup2(channel[1], STDERR_FILENO) < 0)
                _exit(125);
            if (input > STDERR_FILENO) close(input);
            if (channel[1] > STDERR_FILENO) close(channel[1]);
        }
        char *arguments[] = {"opengeni-command-supervisor", (char *)mode, (char *)argument, NULL};
        char *environment[] = {"PATH=/usr/bin:/bin", NULL};
        /* Explicitly selected syscall, no proc-path, loader, copied artifact,
         * chmod, or policy-denial fallback. CLOEXEC is valid for this static ELF. */
        (void)syscall(SYS_execveat, artifact, "", arguments, environment, AT_EMPTY_PATH);
        _exit(125);
    }
    close(barrier[0]);
    if (pty) close(slave); else close(channel[1]);
    int handle = (int)syscall(SYS_pidfd_open, child, 0);
    if (handle < 0) {
        /* EOF releases no code; the child exits at its barrier. */
        close(barrier[1]);
        close(channel[0]);
        long long deadline = milliseconds() + 2000;
        while (milliseconds() < deadline) {
            pid_t observed = waitpid(child, NULL, WNOHANG);
            if (observed == child || (observed < 0 && errno != EINTR)) break;
            (void)poll(NULL, 0, 10);
        }
        fail("broker probe pidfd unavailable");
    }
    signal_handle(handle, 0);
    barrier_write(barrier[1]);
    close(barrier[1]);
    int flags = fcntl(channel[0], F_GETFL);
    if (flags < 0 || fcntl(channel[0], F_SETFL, flags | O_NONBLOCK))
        fail("broker probe nonblocking output unavailable");
    long long deadline = milliseconds() + 5000;
    size_t filled = 0;
    bool eof = false, exited = false, rejected = false;
    int status = 0;
    while (!eof || !exited) {
        unsigned char buffer[4096];
        ssize_t count = read(channel[0], buffer, sizeof(buffer));
        if (count > 0) {
            if ((size_t)count > capacity - filled) { rejected = true; break; }
            memcpy(output + filled, buffer, (size_t)count);
            filled += (size_t)count;
        } else if (count == 0 || (pty && count < 0 && errno == EIO)) eof = true;
        else if (errno != EINTR && errno != EAGAIN) { rejected = true; break; }
        if (!exited) {
            pid_t observed = waitpid(child, &status, WNOHANG);
            if (observed == child) exited = true;
            else if (observed < 0 && errno != EINTR) { rejected = true; break; }
        }
        if (milliseconds() >= deadline) { rejected = true; break; }
        if (!eof || !exited) {
            struct pollfd descriptors[2] = {{.fd = channel[0], .events = POLLIN},
                                           {.fd = handle, .events = POLLIN}};
            if (poll(descriptors, 2, 10) < 0 && errno != EINTR) { rejected = true; break; }
        }
    }
    if (rejected && !exited) {
        signal_handle(handle, SIGKILL);
        long long stop_deadline = milliseconds() + 2000;
        while (!exited && milliseconds() < stop_deadline) {
            pid_t observed = waitpid(child, &status, WNOHANG);
            if (observed == child) exited = true;
            else if (observed < 0 && errno != EINTR) break;
            struct pollfd descriptor = {.fd = handle, .events = POLLIN};
            (void)poll(&descriptor, 1, 10);
        }
    }
    close(handle);
    close(channel[0]);
    if (rejected || !exited || !WIFEXITED(status) || WEXITSTATUS(status) != 0)
        fail("sealed broker probe did not complete");
    return filled;
}

static int broker_preflight(int argc, char **argv) {
    if (argc != 4 || strcmp(argv[2], "--broker-id") || !uuid(argv[3]) ||
        argv[3][14] < '1' || argv[3][14] > '8' || !strchr("89ab", argv[3][19]))
        fail("invalid broker probe identity");
    /* Reset inherited no-wait dispositions before creating proof children. */
    struct sigaction action = {.sa_handler = SIG_DFL};
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGCHLD, &action, NULL)) fail("broker probe SIGCHLD reset failed");
    sigset_t mask;
    sigemptyset(&mask);
    if (sigprocmask(SIG_SETMASK, &mask, NULL)) fail("broker probe signal reset failed");
    struct artifact facts;
    int artifact = sealed_artifact(&facts);
    unsigned char *captured = malloc(BROKER_PROBE_MAX_BYTES + 1);
    unsigned char *raw = malloc(facts.size);
    char *encoded = malloc(BROKER_PROBE_MAX_BYTES + 1);
    if (!captured || !raw || !encoded) fail("broker probe memory unavailable");
    char expected[512];
    int length = snprintf(expected, sizeof(expected),
        "{\"protocol\":\"%s\",\"byteSize\":%zu,\"seals\":%d,\"target\":\"%s\",\"static\":true,"
        "\"device\":\"%ju\",\"inode\":\"%ju\"}", KEEPER_PROTOCOL, facts.size, facts.seals,
        facts.target, facts.device, facts.inode);
    if (length <= 0 || (size_t)length >= sizeof(expected)) fail("broker probe facts overflow");
    size_t size = broker_probe_exec(artifact, "artifact-capabilities", NULL, false,
                                    captured, BROKER_PROBE_MAX_BYTES);
    if (size != (size_t)length || memcmp(captured, expected, size))
        fail("broker probe sealed identity mismatch");
    read_exact_at(artifact, raw, facts.size, 0);
    size_t encoded_size = broker_base64(raw, facts.size, encoded);
    size = broker_probe_exec(artifact, "artifact-bytes", "--base64", false,
                             captured, BROKER_PROBE_MAX_BYTES);
    if (size != encoded_size || memcmp(captured, encoded, size))
        fail("broker probe sealed bytes mismatch");
    size = broker_probe_exec(artifact, "capabilities", NULL, false, captured, BROKER_PROBE_MAX_BYTES);
    if (size != strlen(PROTOCOL) || memcmp(captured, PROTOCOL, size))
        fail("broker probe pipe capability unavailable");
    size = broker_probe_exec(artifact, "capabilities", "--pty", true, captured, BROKER_PROBE_MAX_BYTES);
    if (size != strlen(PTY_PROTOCOL) || memcmp(captured, PTY_PROTOCOL, size))
        fail("broker probe PTY capability unavailable");
    char hello[768];
    length = snprintf(hello, sizeof(hello),
        "{\"protocol\":\"%s\",\"state\":\"preflight_only\",\"sealedExec\":\"execveat\","
        "\"pipeCapability\":\"%s\",\"ptyCapability\":\"%s\",\"artifact\":%s}",
        BROKER_PREFLIGHT_PROTOCOL, PROTOCOL, PTY_PROTOCOL, expected);
    if (length <= 0 || (size_t)length >= sizeof(hello)) fail("broker probe hello overflow");
    unsigned int sequence = 1;
    broker_probe_frame(argv[3], sequence++, "hello", 0, (unsigned char *)hello, (size_t)length);
    for (size_t offset = 0; offset < facts.size; offset += BROKER_CHUNK_BYTES) {
        size_t count = facts.size - offset;
        if (count > BROKER_CHUNK_BYTES) count = BROKER_CHUNK_BYTES;
        broker_probe_frame(argv[3], sequence++, "artifact", offset, raw + offset, count);
    }
    static const unsigned char done[] = "{\"preflightComplete\":true,\"commandAdmission\":false}";
    broker_probe_frame(argv[3], sequence, "exit", 0, done, sizeof(done) - 1);
    free(encoded);
    free(raw);
    free(captured);
    close(artifact);
    return 0;
}

int main(int argc, char **argv) {
    if (argc >= 2 && !strcmp(argv[1], "broker-preflight")) return broker_preflight(argc, argv);
    if (argc >= 2 && !strcmp(argv[1], "keeper")) return keeper(argc, argv);
    if (argc == 2 && !strcmp(argv[1], "artifact-capabilities")) return artifact_capability(false);
    if (argc == 3 && !strcmp(argv[1], "artifact-bytes") && !strcmp(argv[2], "--base64"))
        return artifact_capability(true);
    if (argc >= 2 && !strcmp(argv[1], "service")) {
        if (argc < 4 || strcmp(argv[2], "--")) fail("service requires -- command");
        return service(&argv[3]);
    }
    /* Bounded capability check: exercise the same kernel prerequisites as
     * launch, but create no socket, child or persistent supervisor. */
    if ((argc == 2 || (argc == 3 && !strcmp(argv[2], "--pty"))) &&
        !strcmp(argv[1], "capabilities")) {
        initialize();
        if (argc == 3) close(inherited_terminal());
        printf("%s", argc == 3 ? PTY_PROTOCOL : PROTOCOL);
        return 0;
    }
    struct options o = parse(argc, argv);
    return o.launch ? launch(&o) : control(&o);
}

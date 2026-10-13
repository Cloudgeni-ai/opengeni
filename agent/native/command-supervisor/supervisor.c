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
#include <stddef.h>
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
#define CHANNEL_PROTOCOL "native-subreaper-broker-channel-v1"
#define CHANNEL_PTY_PROTOCOL "native-subreaper-broker-channel-pty-v1"
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
    bool launch, pty, channel;
    int channel_fd;
};

static const char *protocol(const struct options *o) {
    if (o->channel) return o->pty ? CHANNEL_PTY_PROTOCOL : CHANNEL_PROTOCOL;
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
    struct options o = {.channel_fd = -1};
    const char *channel_fd = NULL;
    if (argc < 2) fail("missing subcommand");
    o.channel = !strcmp(argv[1], "launch-channel");
    o.launch = o.channel || !strcmp(argv[1], "launch");
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
        else if (!strcmp(argv[i], "--control-fd")) slot = &channel_fd;
        else if (!strcmp(argv[i], "--action")) slot = &o.action;
        else if (!strcmp(argv[i], "--receipt")) slot = &o.receipt;
        else fail("unknown option");
        if (*slot) fail("duplicate option");
        *slot = argv[++i];
    }
    if (!o.invocation || !uuid(o.invocation) || !o.nonce || !hex(o.nonce, 64))
        fail("invalid identity");
    if (o.channel) {
        if (o.path || !channel_fd || channel_fd[0] < '1' || channel_fd[0] > '9')
            fail("invalid control descriptor");
        unsigned long value = 0;
        for (const char *p = channel_fd; *p; p++) {
            if (*p < '0' || *p > '9' ||
                value > ((unsigned long)INT_MAX - (unsigned long)(*p - '0')) / 10)
                fail("invalid control descriptor");
            value = value * 10 + (unsigned long)(*p - '0');
        }
        if (value < 3) fail("invalid control descriptor");
        o.channel_fd = (int)value;
    } else if (channel_fd || !o.path || o.path[0] != '/' ||
               strlen(o.path) >= sizeof(((struct sockaddr_un *)0)->sun_path))
        fail("invalid socket path");
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

static bool send_frame(int fd, const char *message) {
    /* Lost client/ACK response does not destroy the replayable receipt. */
    ssize_t size;
    do { size = send(fd, message, strlen(message), MSG_NOSIGNAL | MSG_DONTWAIT); }
    while (size < 0 && errno == EINTR);
    return size == (ssize_t)strlen(message);
}

/* This is a topology check, not authentication of an arbitrary guest peer.
 * Only the admitted initial broker may create/pass this private socketpair.
 * SO_PEERCRED describes creation-time identity, not a current sender or a
 * hostile same-UID isolation boundary. No guest-path control is accepted. */
static int inherited_control_channel(int fd) {
    int type = 0;
    socklen_t size = sizeof(type);
    if (getsockopt(fd, SOL_SOCKET, SO_TYPE, &type, &size) ||
        size != sizeof(type) || type != SOCK_SEQPACKET)
        fail("private control socket type unavailable");
    struct sockaddr_un address;
    memset(&address, 0, sizeof(address));
    size = sizeof(address);
    if (getsockname(fd, (struct sockaddr *)&address, &size) ||
        size != offsetof(struct sockaddr_un, sun_path) || address.sun_family != AF_UNIX)
        fail("private control local endpoint unavailable");
    memset(&address, 0, sizeof(address));
    size = sizeof(address);
    if (getpeername(fd, (struct sockaddr *)&address, &size) ||
        size != offsetof(struct sockaddr_un, sun_path) || address.sun_family != AF_UNIX)
        fail("private control peer endpoint unavailable");
    struct ucred credentials;
    size = sizeof(credentials);
    if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &credentials, &size) ||
        size != sizeof(credentials) || credentials.pid != getppid() ||
        credentials.uid != geteuid() || credentials.gid != getegid())
        fail("private control parent identity unavailable");
    int flags = fcntl(fd, F_GETFL);
    if (flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) ||
        fcntl(fd, F_SETFD, FD_CLOEXEC)) fail("private control descriptor flags unavailable");
    return fd;
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
        if (listener != client) close(listener);
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
    int listener;
    if (o->channel) listener = inherited_control_channel(o->channel_fd);
    else {
        validate_directory(o->path, true);
        listener = socket(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
        if (listener < 0) fail("control socket unavailable");
        struct sockaddr_un address = socket_address(o->path);
        mode_t previous = umask(0077);
        int bound = bind(listener, (struct sockaddr *)&address, sizeof(address));
        umask(previous);
        /* Never unlink an existing socket, including an earlier invocation. */
        if (bound || listen(listener, 16)) fail("control bind failed");
    }
    bool started = false, cancelled = false, quiescent = false, leader_seen = false;
    bool channel_lost = false;
    pid_t leader = 0;
    struct launch_barrier barrier = {.prepared = -1, .release = -1};
    int leader_exit = 125; /* Cancelled before release: no leader was launched. */
    long long cancel_at = 0;
    char receipt_id[37], response[FRAME_SIZE];
    make_receipt_id(receipt_id);
    for (;;) {
        if (channel_lost && !cancelled) {
            cancelled = true;
            cancel_at = milliseconds();
        }
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
        if (channel_lost) {
            if (quiescent) {
                if (terminal >= 0) close(terminal);
                /* A drained child set is not a delivered receipt or clean ACK. */
                return 125;
            }
            (void)poll(NULL, 0, 10);
            continue;
        }
        int client;
        if (o->channel) {
            struct pollfd p = {.fd = listener, .events = POLLIN};
            int observed;
            do { observed = poll(&p, 1, 10); } while (observed < 0 && errno == EINTR);
            if (observed < 0 || (p.revents & (POLLHUP | POLLERR | POLLNVAL))) {
                close(listener);
                channel_lost = true;
                continue;
            }
            if (!observed || !(p.revents & POLLIN)) continue;
            client = listener;
        } else {
            if (!ready(listener, POLLIN, 10)) continue;
            client = accept4(listener, NULL, NULL, SOCK_CLOEXEC | SOCK_NONBLOCK);
            if (client < 0) {
                if (errno == EAGAIN || errno == EINTR) continue;
                fail("control accept failed");
            }
        }
        char frame[FRAME_SIZE];
        bool ack = false, sent = true, frame_valid;
        if (o->channel) {
            ssize_t count;
            do { count = recv(client, frame, FRAME_SIZE - 1, MSG_TRUNC | MSG_DONTWAIT); }
            while (count < 0 && errno == EINTR);
            if (count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) continue;
            if (count <= 0) {
                close(listener);
                channel_lost = true;
                continue;
            }
            frame_valid = count < FRAME_SIZE - 1 && !memchr(frame, 0, (size_t)count);
            if (frame_valid) frame[count] = 0;
        } else {
            if (!ready(client, POLLIN, 100) || receive_frame(client, frame) < 0) {
                close(client);
                continue;
            }
            frame_valid = true;
        }
        char *fields[5] = {0}, *position = frame;
        bool valid = frame_valid;
        for (int i = 0; valid && i < 5; i++) {
            fields[i] = strsep(&position, "\t");
            if (!fields[i]) valid = false;
        }
        valid = valid && !position && !strcmp(fields[0], protocol(o)) &&
            !strcmp(fields[1], o->invocation) && !strcmp(fields[2], o->nonce);
        if (!valid) {
            sent = send_frame(client, "{\"error\":\"unauthenticated\"}");
        } else if (!strcmp(fields[3], "ack")) {
            ack = quiescent && !strcmp(fields[4], receipt_id);
            sent = send_frame(client, ack ? response : "{\"error\":\"receipt_mismatch\"}");
        } else if (strcmp(fields[4], "-") || (strcmp(fields[3], "release") &&
            strcmp(fields[3], "cancel") && strcmp(fields[3], "status"))) {
            sent = send_frame(client, "{\"error\":\"invalid_action\"}");
        } else {
            if (!strcmp(fields[3], "cancel") && !cancelled && !quiescent) {
                cancelled = true;
                cancel_at = milliseconds();
            }
            if (!strcmp(fields[3], "release") && !started && !cancelled && !quiescent) {
                leader = start_command(o, listener, client, terminal, &barrier);
                started = true;
            }
            sent = send_frame(client, quiescent ? response :
                (started || cancelled ? "{\"state\":\"running\"}" : "{\"state\":\"idle\"}"));
        }
        if (!o->channel) close(client);
        else if (!sent) {
            close(listener);
            channel_lost = true;
            continue;
        }
        if (ack) {
            close(listener);
            if (terminal >= 0) close(terminal);
            /* Control housekeeping only; never mutate /workspace after proof. */
            if (!o->channel && unlink(o->path)) fail("control cleanup failed");
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

#define BROKER_DEFINITION_MAX_BYTES (256 * 1024)
#define BROKER_DEFINITION_MAX_ENTRIES 1024
#define BROKER_DEFINITION_MAX_STRING (128 * 1024 - 1)

/* Internal explicit command body, never a shell template or inherited env.
 * This parser alone does not authorize or start a supervisor. The native broker
 * owns a separate launch transition; external linkage also permits the actual
 * decoder to be exercised by the native/host parity harness. */
struct broker_definition {
    char *cwd, **argv, **env;
    size_t argc, envc;
    unsigned short rows, columns;
    bool pty;
};

void broker_definition_free(struct broker_definition *definition) {
    free(definition->cwd);
    if (definition->argv)
        for (size_t i = 0; i < definition->argc; i++) free(definition->argv[i]);
    if (definition->env)
        for (size_t i = 0; i < definition->envc; i++) free(definition->env[i]);
    free(definition->argv);
    free(definition->env);
    memset(definition, 0, sizeof(*definition));
}

struct broker_definition_reader { const unsigned char *bytes; size_t size, offset; };

static bool broker_definition_u32(struct broker_definition_reader *reader, uint32_t *value) {
    if (reader->offset > reader->size || reader->size - reader->offset < 4) return false;
    const unsigned char *p = reader->bytes + reader->offset;
    *value = ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3];
    reader->offset += 4;
    return true;
}

static bool broker_definition_utf8(const unsigned char *bytes, size_t size) {
    size_t i = 0;
    while (i < size) {
        unsigned int first = bytes[i++];
        if (first == 0) return false;
        if (first <= 0x7f) continue;
        unsigned int code, minimum;
        size_t following;
        if (first >= 0xc2 && first <= 0xdf) { code = first & 0x1f; minimum = 0x80; following = 1; }
        else if (first >= 0xe0 && first <= 0xef) { code = first & 0x0f; minimum = 0x800; following = 2; }
        else if (first >= 0xf0 && first <= 0xf4) { code = first & 0x07; minimum = 0x10000; following = 3; }
        else return false;
        if (following > size - i) return false;
        while (following--) {
            unsigned int next = bytes[i++];
            if ((next & 0xc0) != 0x80) return false;
            code = (code << 6) | (next & 0x3f);
        }
        if (code < minimum || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return false;
    }
    return true;
}

static char *broker_definition_text(struct broker_definition_reader *reader) {
    uint32_t count;
    if (!broker_definition_u32(reader, &count) || count > BROKER_DEFINITION_MAX_STRING ||
        count > reader->size - reader->offset ||
        !broker_definition_utf8(reader->bytes + reader->offset, count)) return NULL;
    char *text = malloc((size_t)count + 1);
    if (!text) return NULL;
    memcpy(text, reader->bytes + reader->offset, count);
    text[count] = 0;
    reader->offset += count;
    return text;
}

static bool broker_environment_key(const char *key) {
    for (size_t i = 0; key[i]; i++) {
        unsigned char c = (unsigned char)key[i];
        if (c != '_' && !(c >= 'a' && c <= 'z') && !(c >= 'A' && c <= 'Z') &&
            !(i && c >= '0' && c <= '9')) return false;
    }
    return *key != 0;
}

bool broker_definition_decode(const unsigned char *bytes, size_t size,
                              struct broker_definition *definition) {
    memset(definition, 0, sizeof(*definition));
    if (size < 20 || size > BROKER_DEFINITION_MAX_BYTES || memcmp(bytes, "OGCD1\0", 6) ||
        bytes[6] > 1 || bytes[7]) return false;
    definition->pty = bytes[6] != 0;
    definition->rows = (unsigned short)((unsigned int)bytes[8] << 8 | bytes[9]);
    definition->columns = (unsigned short)((unsigned int)bytes[10] << 8 | bytes[11]);
    if (definition->pty ? (!definition->rows || !definition->columns) :
                          (definition->rows || definition->columns)) goto rejected;
    struct broker_definition_reader reader = {.bytes = bytes, .size = size, .offset = 12};
    uint32_t argc, envc;
    if (!broker_definition_u32(&reader, &argc) || !broker_definition_u32(&reader, &envc) ||
        !argc || argc > BROKER_DEFINITION_MAX_ENTRIES || envc > BROKER_DEFINITION_MAX_ENTRIES)
        goto rejected;
    definition->argc = argc;
    definition->envc = envc;
    definition->argv = calloc((size_t)argc + 1, sizeof(char *));
    definition->env = calloc((size_t)envc + 1, sizeof(char *));
    definition->cwd = broker_definition_text(&reader);
    if (!definition->argv || !definition->env || !definition->cwd || definition->cwd[0] != '/')
        goto rejected;
    for (size_t i = 0; i < argc; i++) {
        definition->argv[i] = broker_definition_text(&reader);
        if (!definition->argv[i] || (!i && !definition->argv[i][0])) goto rejected;
    }
    for (size_t i = 0; i < envc; i++) {
        char *key = broker_definition_text(&reader);
        char *value = broker_definition_text(&reader);
        if (!key || !value || !broker_environment_key(key)) {
            free(key); free(value); goto rejected;
        }
        size_t length = strlen(key), value_length = strlen(value);
        for (size_t j = 0; j < i; j++) {
            if (!strncmp(definition->env[j], key, length) && definition->env[j][length] == '=') {
                free(key); free(value); goto rejected;
            }
        }
        if (length + 1 + value_length > BROKER_DEFINITION_MAX_STRING) {
            free(key); free(value); goto rejected;
        }
        char *pair = malloc(length + 1 + value_length + 1);
        if (!pair) { free(key); free(value); goto rejected; }
        memcpy(pair, key, length);
        pair[length] = '=';
        memcpy(pair + length + 1, value, value_length + 1);
        definition->env[i] = pair;
        free(key); free(value);
    }
    if (reader.offset != size) goto rejected;
    return true;
rejected:
    broker_definition_free(definition);
    return false;
}

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

#define BROKER_FRAME_MAX_BYTES (12 * 1024)
#define BROKER_SAFE_INTEGER UINT64_C(9007199254740991)

enum broker_request_kind {
    BROKER_HELLO, BROKER_FENCE, BROKER_PREPARE, BROKER_DEFINITION, BROKER_LAUNCH,
    BROKER_STDIN, BROKER_EOF, BROKER_RESIZE, BROKER_CONTROL, BROKER_ACK, BROKER_REPLAY
};

static const char *const broker_request_names[] = {
    "hello", "fence", "prepare", "definition", "launch", "stdin", "eof", "resize",
    "control", "ack", "replay"
};

struct broker_request {
    char broker_id[37], request_id[37], command_id[37];
    uint64_t epoch, sequence, offset;
    enum broker_request_kind kind;
    bool broker_level;
    size_t size;
    unsigned char payload[BROKER_CHUNK_BYTES];
};

static bool broker_uuid(const char *value) {
    return uuid(value) && value[14] >= '1' && value[14] <= '8' &&
        strchr("89ab", value[19]) != NULL;
}

static bool broker_decimal(const char *text, uint64_t minimum, uint64_t maximum, uint64_t *result) {
    if (!text[0] || (text[0] == '0' && text[1])) return false;
    uint64_t value = 0;
    for (const char *p = text; *p; p++) {
        if (*p < '0' || *p > '9') return false;
        uint64_t digit = (uint64_t)(*p - '0');
        if (value > (maximum - digit) / 10) return false;
        value = value * 10 + digit;
    }
    if (value < minimum || value > maximum) return false;
    *result = value;
    return true;
}

static int broker_base64_digit(unsigned char c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    return c == '+' ? 62 : c == '/' ? 63 : -1;
}

static bool broker_unbase64(const char *encoded, size_t expected, unsigned char *output) {
    size_t length = strlen(encoded), written = 0;
    if (expected > BROKER_CHUNK_BYTES || length != ((expected + 2) / 3) * 4) return false;
    for (size_t i = 0; i < length; i += 4) {
        int a = broker_base64_digit((unsigned char)encoded[i]);
        int b = broker_base64_digit((unsigned char)encoded[i + 1]);
        int c = encoded[i + 2] == '=' ? 0 : broker_base64_digit((unsigned char)encoded[i + 2]);
        int d = encoded[i + 3] == '=' ? 0 : broker_base64_digit((unsigned char)encoded[i + 3]);
        if (a < 0 || b < 0 || c < 0 || d < 0 || written >= expected) return false;
        output[written++] = (unsigned char)((a << 2) | (b >> 4));
        if (encoded[i + 2] == '=') {
            if (encoded[i + 3] != '=' || (b & 15) || i + 4 != length || written != expected)
                return false;
            continue;
        }
        if (written >= expected) return false;
        output[written++] = (unsigned char)((b << 4) | (c >> 2));
        if (encoded[i + 3] == '=') {
            if ((c & 3) || i + 4 != length || written != expected) return false;
            continue;
        }
        if (written >= expected) return false;
        output[written++] = (unsigned char)((c << 6) | d);
    }
    return written == expected;
}

/* Framing only, not authentication, ownership, semantic acceptance or replay.
 * The caller must poison its stream on false, never scan for a later marker.
 * Consume one complete LF-terminated request and keep no pointers into input.
 * The broker state machine separately enforces the provider's uint32 sequence
 * bound, writer fencing and operation-specific bodies before any side effect. */
bool broker_request_decode(const unsigned char *bytes, size_t size, const char *broker_id,
                           struct broker_request *request) {
    memset(request, 0, sizeof(*request));
    if (!broker_uuid(broker_id) || !size || size > BROKER_FRAME_MAX_BYTES || bytes[size - 1] != '\n')
        return false;
    char line[BROKER_FRAME_MAX_BYTES];
    for (size_t i = 0; i < size - 1; i++) {
        if (bytes[i] != '\t' && (bytes[i] < 32 || bytes[i] > 126)) return false;
        line[i] = (char)bytes[i];
    }
    line[size - 1] = 0;
    char *fields[12] = {0}, *position = line;
    for (size_t i = 0; i < 12; i++) {
        fields[i] = strsep(&position, "\t");
        if (!fields[i]) goto rejected;
    }
    if (position || strcmp(fields[0], "OGB1") || strcmp(fields[1], "request") ||
        strcmp(fields[2], broker_id) || !broker_uuid(fields[5]) ||
        (strcmp(fields[6], "-") && !broker_uuid(fields[6])) || strcmp(fields[10], "base64"))
        goto rejected;
    bool found = false;
    for (size_t i = 0; i < sizeof(broker_request_names) / sizeof(broker_request_names[0]); i++) {
        if (!strcmp(fields[7], broker_request_names[i])) {
            request->kind = (enum broker_request_kind)i;
            found = true;
            break;
        }
    }
    uint64_t count;
    if (!found || !broker_decimal(fields[3], 1, BROKER_SAFE_INTEGER, &request->epoch) ||
        !broker_decimal(fields[4], 1, BROKER_SAFE_INTEGER, &request->sequence) ||
        !broker_decimal(fields[8], 0, BROKER_SAFE_INTEGER, &request->offset) ||
        !broker_decimal(fields[9], 0, BROKER_CHUNK_BYTES, &count) ||
        request->offset > BROKER_SAFE_INTEGER - count ||
        !broker_unbase64(fields[11], (size_t)count, request->payload)) goto rejected;
    request->size = (size_t)count;
    memcpy(request->broker_id, broker_id, 37);
    memcpy(request->request_id, fields[5], 37);
    request->broker_level = !strcmp(fields[6], "-");
    if (!request->broker_level) memcpy(request->command_id, fields[6], 37);
    return true;
rejected:
    memset(request, 0, sizeof(*request));
    return false;
}

struct broker_input_state {
    char broker_id[37];
    uint64_t epoch;
    uint32_t sequence;
    size_t previous_size;
    unsigned char previous[BROKER_FRAME_MAX_BYTES];
};

enum broker_input_result { BROKER_INPUT_INVALID, BROKER_INPUT_REJECTED,
                           BROKER_INPUT_NEW, BROKER_INPUT_REPLAY };

bool broker_input_initialize(struct broker_input_state *state, const char *broker_id) {
    memset(state, 0, sizeof(*state));
    if (!broker_uuid(broker_id)) return false;
    memcpy(state->broker_id, broker_id, 37);
    return true;
}

/* Input ordering only. A NEW result reserves this exact input before its
 * operation can have a side effect. The caller must retain/emit acceptance and
 * the distinct operation result; REPLAY must never execute the operation.
 * The host journal permits only one pending indexed body. Only the immediately
 * previous body may replay, and only byte-for-byte; older indexes reject even
 * if once valid. Global request-ID uniqueness and command birth/admission are
 * separate durable obligations, not proved by this bounded native memory.
 * INVALID requires the future stream owner to poison/close its input; no scan
 * for a later marker. REJECTED is a valid frame with disallowed ordering/fence.
 */
enum broker_input_result broker_input_accept(struct broker_input_state *state,
    const unsigned char *bytes, size_t size, struct broker_request *request) {
    if (!broker_request_decode(bytes, size, state->broker_id, request)) return BROKER_INPUT_INVALID;
    if (state->previous_size > BROKER_FRAME_MAX_BYTES ||
        (state->sequence == 0 ? (state->epoch != 0 || state->previous_size != 0) :
                               (state->epoch == 0 || state->previous_size == 0)) ||
        state->epoch > BROKER_SAFE_INTEGER || request->sequence > UINT32_MAX)
        return BROKER_INPUT_REJECTED;
    if (request->sequence == state->sequence && state->sequence > 0)
        return size == state->previous_size && !memcmp(bytes, state->previous, size) ?
            BROKER_INPUT_REPLAY : BROKER_INPUT_REJECTED;
    if (state->sequence == UINT32_MAX || request->sequence != (uint64_t)state->sequence + 1)
        return BROKER_INPUT_REJECTED;
    if (request->kind == BROKER_FENCE) {
        if (!request->broker_level || request->offset || request->size || request->epoch <= state->epoch)
            return BROKER_INPUT_REJECTED;
    } else if (!state->epoch || request->epoch != state->epoch) return BROKER_INPUT_REJECTED;
    state->epoch = request->epoch;
    state->sequence = (uint32_t)request->sequence;
    state->previous_size = size;
    memcpy(state->previous, bytes, size);
    return BROKER_INPUT_NEW;
}

#define BROKER_OUTPUT_MAX_BYTES (4 * 1024 * 1024)
#define BROKER_OUTPUT_CONTROL_RESERVE (128 * 1024)

struct broker_output_frame {
    struct broker_output_frame *next;
    uint64_t sequence;
    size_t size, written;
    char bytes[];
};

struct broker_output_queue {
    struct broker_output_frame *first, *last;
    uint64_t sequence, acknowledged, sent_through;
    size_t bytes;
};

static bool broker_response_kind(const char *kind) {
    const char *names[] = {"hello", "artifact", "accepted", "status", "stdout", "stderr", "exit", "error"};
    for (size_t i = 0; i < sizeof(names) / sizeof(names[0]); i++)
        if (!strcmp(kind, names[i])) return true;
    return false;
}

static void broker_output_collect(struct broker_output_queue *queue) {
    while (queue->first && queue->first->sequence <= queue->acknowledged) {
        struct broker_output_frame *frame = queue->first;
        /* An ACK may race replay of bytes already captured by the host. Finish
         * a partly written replay line before freeing it; otherwise the next
         * frame would concatenate onto that partial line and poison the log. */
        if (frame->written && frame->written < frame->size) break;
        queue->first = frame->next;
        queue->bytes -= sizeof(*frame) + frame->size;
        free(frame);
    }
    if (!queue->first) queue->last = NULL;
}

void broker_output_free(struct broker_output_queue *queue) {
    while (queue->first) {
        struct broker_output_frame *next = queue->first->next;
        free(queue->first);
        queue->first = next;
    }
    memset(queue, 0, sizeof(*queue));
}

/* False is bounded pressure or invalid input, never permission to discard
 * output. Future callers must keep command reads paused while continuing their
 * independent control/reaper loop. Only trusted metadata uses control reserve;
 * ordinary command output cannot select it. Nothing is emitted by this call. */
bool broker_output_append(struct broker_output_queue *queue, const char *broker_id,
    uint64_t epoch, const char *request_id, const char *command_id, const char *kind,
    uint64_t offset, const unsigned char *payload, size_t size, bool control) {
    if (!broker_uuid(broker_id) || !broker_uuid(request_id) ||
        (command_id && !broker_uuid(command_id)) || !broker_response_kind(kind) ||
        epoch == 0 || epoch > BROKER_SAFE_INTEGER || queue->sequence >= BROKER_SAFE_INTEGER ||
        size > BROKER_CHUNK_BYTES || offset > BROKER_SAFE_INTEGER - size ||
        ((!strcmp(kind, "stdout") || !strcmp(kind, "stderr")) && control)) return false;
    char encoded[((BROKER_CHUNK_BYTES + 2) / 3) * 4 + 1];
    (void)broker_base64(payload, size, encoded);
    char header[512];
    uint64_t sequence = queue->sequence + 1;
    int count = snprintf(header, sizeof(header),
        "OGB1\tresponse\t%s\t%" PRIu64 "\t%" PRIu64 "\t%s\t%s\t%s\t%" PRIu64 "\t%zu\tbase64\t",
        broker_id, epoch, sequence, request_id, command_id ? command_id : "-", kind, offset, size);
    if (count <= 0 || (size_t)count >= sizeof(header)) return false;
    size_t encoded_size = strlen(encoded), frame_size = (size_t)count + encoded_size + 1;
    size_t capacity = BROKER_OUTPUT_MAX_BYTES - (control ? 0 : BROKER_OUTPUT_CONTROL_RESERVE);
    size_t allocation = sizeof(struct broker_output_frame) + frame_size;
    if (frame_size > BROKER_FRAME_MAX_BYTES || queue->bytes > capacity ||
        allocation > capacity - queue->bytes) return false;
    struct broker_output_frame *frame = malloc(allocation);
    if (!frame) return false;
    *frame = (struct broker_output_frame){.sequence = sequence, .size = frame_size};
    memcpy(frame->bytes, header, (size_t)count);
    memcpy(frame->bytes + count, encoded, encoded_size);
    frame->bytes[frame_size - 1] = '\n';
    if (queue->last) queue->last->next = frame; else queue->first = frame;
    queue->last = frame;
    queue->bytes += allocation;
    queue->sequence = sequence;
    return true;
}

/* The initial-process stdout descriptor must already be nonblocking. A caller
 * must never pass a guest command's descriptor or reinterpret a false return
 * as complete output. Work per tick is bounded independently of cancellation. */
bool broker_output_flush(struct broker_output_queue *queue, int fd, size_t budget) {
    int flags = fcntl(fd, F_GETFL);
    if (flags < 0 || !(flags & O_NONBLOCK)) return false;
    for (struct broker_output_frame *frame = queue->first; frame && budget; frame = frame->next) {
        if (frame->written == frame->size) continue;
        size_t count = frame->size - frame->written;
        if (count > budget) count = budget;
        ssize_t written;
        do { written = write(fd, frame->bytes + frame->written, count); }
        while (written < 0 && errno == EINTR);
        if (written < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return true;
        if (written <= 0) return false;
        frame->written += (size_t)written;
        budget -= (size_t)written;
        if (frame->written == frame->size) {
            if (frame->sequence > queue->sent_through) queue->sent_through = frame->sequence;
        } else break; /* Never interleave part of the next protocol line. */
    }
    broker_output_collect(queue);
    return true;
}

bool broker_output_acknowledge(struct broker_output_queue *queue, uint64_t sequence) {
    if (sequence < queue->acknowledged || sequence > queue->sent_through) return false;
    queue->acknowledged = sequence;
    broker_output_collect(queue);
    return true;
}

/* Replay starts at the oldest unacknowledged frame. There is no cursor reset,
 * skipped prefix or fresh sequence assignment. A partial physical write must
 * finish before replay can rewind; false leaves all cursors unchanged. */
bool broker_output_replay(struct broker_output_queue *queue, uint64_t first) {
    if (first != queue->acknowledged + 1) return false;
    for (struct broker_output_frame *frame = queue->first; frame; frame = frame->next)
        if (frame->written && frame->written < frame->size) return false;
    for (struct broker_output_frame *frame = queue->first; frame; frame = frame->next)
        frame->written = 0;
    return true;
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

#define BROKER_PROTOCOL "native-command-broker-v1"
#define BROKER_COMMAND_MEMORY (16 * 1024 * 1024)
#define BROKER_REPLY_SPACE (2 * BROKER_FRAME_MAX_BYTES)

struct broker_command {
    struct broker_command *next;
    char id[37], nonce[65], launch_request[37], control_request[37], input_request[37];
    uint64_t epoch, control_epoch, input_epoch, input_offset, output_offset[2];
    unsigned char *definition;
    size_t definition_size, definition_filled;
    pid_t pid;
    int handle, control, input, output[2];
    bool launched, launch_closed, pty, exited, exit_reported, eof_reported[2], input_eof;
    int exit_code;
    unsigned char *pending_input;
    size_t input_size, input_written;
};

struct broker {
    int artifact, signals;
    struct artifact facts;
    struct broker_input_state input;
    struct broker_output_queue output;
    struct broker_command *commands;
    size_t command_memory;
    struct pollfd *polls;
    size_t poll_capacity;
};

static bool broker_nonblocking(int fd) {
    int flags = fcntl(fd, F_GETFL);
    return flags >= 0 && fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0;
}

static void broker_close(int *fd) {
    if (*fd >= 0) close(*fd);
    *fd = -1;
}

static bool broker_reply(struct broker *broker, const struct broker_request *request,
                         const char *kind, uint64_t offset, const char *body) {
    return broker_output_append(&broker->output, broker->input.broker_id, request->epoch,
        request->request_id, request->broker_level ? NULL : request->command_id,
        kind, offset, (const unsigned char *)body, strlen(body), true);
}

static bool broker_error(struct broker *broker, const struct broker_request *request, const char *code) {
    /* Only fixed content-free codes, never caller-controlled strings. */
    char body[96];
    int size = snprintf(body, sizeof(body), "{\"error\":\"%s\"}", code);
    return size > 0 && (size_t)size < sizeof(body) && broker_reply(broker, request, "error", 0, body);
}

static void broker_nonce(char nonce[65]) {
    unsigned char bytes[32];
    size_t filled = 0;
    while (filled < sizeof(bytes)) {
        ssize_t count = getrandom(bytes + filled, sizeof(bytes) - filled, 0);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) fail("broker randomness unavailable");
        filled += (size_t)count;
    }
    for (size_t i = 0; i < sizeof(bytes); i++)
        (void)snprintf(nonce + i * 2, 3, "%02x", bytes[i]);
}

/* All opened endpoints are private to this initial process. The child cannot
 * exec until its parent owns a pidfd. No PDEATHSIG kills a live subreaper: loss
 * of this broker instead closes the private control channel and lets it drain.
 * A failure after fork retains pid/handle for the broker's all-child shutdown;
 * it is never returned as a safe retry or forgotten physical child. */
static bool broker_spawn(struct broker *broker, struct broker_command *command,
                         const struct broker_definition *definition) {
    int control_pair[2] = {-1, -1}, input[2] = {-1, -1}, output[2] = {-1, -1};
    int error[2] = {-1, -1}, barrier[2] = {-1, -1}, master = -1, slave = -1;
    bool success = false;
    char **arguments = calloc(definition->argc + 12, sizeof(char *));
    if (!arguments) return false;
    if (socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0, control_pair) ||
        pipe2(barrier, O_CLOEXEC)) goto done;
    if (definition->pty) {
        master = posix_openpt(O_RDWR | O_NOCTTY | O_CLOEXEC);
        if (master < 0 || grantpt(master) || unlockpt(master)) goto done;
        char *name = ptsname(master);
        if (!name) goto done;
        slave = open(name, O_RDWR | O_NOCTTY | O_CLOEXEC | O_NOFOLLOW);
        struct winsize dimensions = {.ws_row = definition->rows, .ws_col = definition->columns};
        if (slave < 0 || ioctl(slave, TIOCSWINSZ, &dimensions)) goto done;
    } else if (pipe2(input, O_CLOEXEC) || pipe2(output, O_CLOEXEC) || pipe2(error, O_CLOEXEC)) goto done;
    char descriptor[24];
    (void)snprintf(descriptor, sizeof(descriptor), "%d", control_pair[1]);
    size_t argc = 0;
    arguments[argc++] = "opengeni-command-supervisor";
    arguments[argc++] = "launch-channel";
    arguments[argc++] = "--control-fd"; arguments[argc++] = descriptor;
    arguments[argc++] = "--invocation"; arguments[argc++] = command->id;
    arguments[argc++] = "--nonce"; arguments[argc++] = command->nonce;
    if (definition->pty) arguments[argc++] = "--pty";
    arguments[argc++] = "--";
    for (size_t i = 0; i < definition->argc; i++) arguments[argc++] = definition->argv[i];
    pid_t child = fork();
    if (child < 0) goto done;
    if (!child) {
        close(barrier[1]);
        child_signals();
        char release;
        ssize_t count;
        do { count = read(barrier[0], &release, 1); } while (count < 0 && errno == EINTR);
        if (count != 1 || release != '+') _exit(125);
        close(barrier[0]);
        /* Mark every inherited private endpoint close-on-exec in one bounded
         * kernel operation. Denial is not permission to leak a sibling channel.
         * The only extra surviving descriptor is this child's control endpoint. */
        if (syscall(SYS_close_range, 3U, ~0U, 4U /* CLOSE_RANGE_CLOEXEC */) ||
            fcntl(control_pair[1], F_SETFD, 0) || setsid() < 0 || chdir(definition->cwd)) _exit(125);
        if (definition->pty) {
            if (ioctl(slave, TIOCSCTTY, 0) || dup2(slave, 0) < 0 ||
                dup2(slave, 1) < 0 || dup2(slave, 2) < 0) _exit(125);
        } else if (dup2(input[0], 0) < 0 || dup2(output[1], 1) < 0 || dup2(error[1], 2) < 0) _exit(125);
        (void)syscall(SYS_execveat, broker->artifact, "", arguments, definition->env, AT_EMPTY_PATH);
        _exit(125);
    }
    command->pid = child;
    close(barrier[0]); barrier[0] = -1;
    command->handle = (int)syscall(SYS_pidfd_open, child, 0);
    if (command->handle < 0) goto done; /* EOF forbids exec; child remains owned. */
    close(control_pair[1]); control_pair[1] = -1;
    command->control = control_pair[0]; control_pair[0] = -1;
    if (definition->pty) {
        close(slave); slave = -1;
        command->output[0] = master; master = -1;
        command->input = fcntl(command->output[0], F_DUPFD_CLOEXEC, 3);
    } else {
        close(input[0]); input[0] = -1;
        close(output[1]); output[1] = -1;
        close(error[1]); error[1] = -1;
        command->input = input[1]; input[1] = -1;
        command->output[0] = output[0]; output[0] = -1;
        command->output[1] = error[0]; error[0] = -1;
    }
    if (command->input < 0 || !broker_nonblocking(command->control) ||
        !broker_nonblocking(command->input) || !broker_nonblocking(command->output[0]) ||
        (!definition->pty && !broker_nonblocking(command->output[1]))) goto done;
    ssize_t written;
    do { written = write(barrier[1], "+", 1); } while (written < 0 && errno == EINTR);
    success = written == 1;
done:
    for (int i = 0; i < 2; i++) {
        broker_close(&control_pair[i]); broker_close(&input[i]); broker_close(&output[i]);
        broker_close(&error[i]); broker_close(&barrier[i]);
    }
    broker_close(&master); broker_close(&slave);
    free(arguments);
    return success;
}

static struct broker_command *broker_find(struct broker *broker, const char *id) {
    for (struct broker_command *command = broker->commands; command; command = command->next)
        if (!strcmp(command->id, id)) return command;
    return NULL;
}

static bool broker_prepare(struct broker *broker, const struct broker_request *request) {
    if (request->offset || request->size != 4 || broker_find(broker, request->command_id))
        return broker_error(broker, request, "invalid_prepare");
    struct broker_definition_reader reader = {.bytes = request->payload, .size = request->size};
    uint32_t size;
    if (!broker_definition_u32(&reader, &size) || size < 20 || size > BROKER_DEFINITION_MAX_BYTES)
        return broker_error(broker, request, "invalid_definition_size");
    size_t required = sizeof(struct broker_command) + size;
    if (required > BROKER_COMMAND_MEMORY - broker->command_memory)
        return broker_error(broker, request, "command_memory_pressure");
    struct broker_command *command = calloc(1, sizeof(*command));
    if (!command) return broker_error(broker, request, "command_memory_pressure");
    command->definition = malloc(size);
    if (!command->definition) { free(command); return broker_error(broker, request, "command_memory_pressure"); }
    command->definition_size = size;
    command->epoch = request->epoch;
    command->handle = command->control = command->input = command->output[0] = command->output[1] = -1;
    memcpy(command->id, request->command_id, 37);
    broker_nonce(command->nonce);
    command->next = broker->commands;
    broker->commands = command;
    broker->command_memory += required;
    return broker_reply(broker, request, "status", 0, "{\"state\":\"preparing\"}");
}

static bool broker_command_request(struct broker *broker, const struct broker_request *request) {
    if (request->kind == BROKER_PREPARE) return broker_prepare(broker, request);
    struct broker_command *command = broker_find(broker, request->command_id);
    if (!command) return broker_error(broker, request, "command_unknown");
    if (request->kind == BROKER_CONTROL && !command->launched && request->offset == 0 &&
        request->size == 6 && !memcmp(request->payload, "cancel", 6)) {
        command->launch_closed = true;
        if (command->definition) {
            free(command->definition); command->definition = NULL;
            broker->command_memory -= command->definition_size;
            command->definition_size = command->definition_filled = 0;
        }
        /* Positive local pre-spawn rejection, deliberately not a quiescence
         * receipt from a supervisor that never existed. */
        return broker_reply(broker, request, "status", 0, "{\"state\":\"not_started\",\"launchClosed\":true}");
    }
    if (request->kind == BROKER_DEFINITION) {
        if (command->launched || command->launch_closed || !request->size ||
            request->offset != command->definition_filled ||
            request->size > command->definition_size - command->definition_filled)
            return broker_error(broker, request, "invalid_definition_chunk");
        memcpy(command->definition + command->definition_filled, request->payload, request->size);
        command->definition_filled += request->size;
        return broker_reply(broker, request, "status", command->definition_filled, "{\"state\":\"preparing\"}");
    }
    if (request->kind == BROKER_LAUNCH) {
        if (request->offset || request->size || command->launched || command->launch_closed ||
            command->definition_filled != command->definition_size)
            return broker_error(broker, request, "invalid_launch");
        struct broker_definition definition;
        if (!broker_definition_decode(command->definition, command->definition_size, &definition)) {
            command->launch_closed = true;
            free(command->definition); command->definition = NULL;
            broker->command_memory -= command->definition_size;
            command->definition_size = command->definition_filled = 0;
            return broker_error(broker, request, "invalid_definition");
        }
        command->launched = command->launch_closed = true; /* reserve birth before fork */
        command->pty = definition.pty;
        command->epoch = request->epoch;
        memcpy(command->launch_request, request->request_id, 37);
        bool spawned = broker_spawn(broker, command, &definition);
        broker_definition_free(&definition);
        free(command->definition); command->definition = NULL;
        broker->command_memory -= command->definition_size;
        command->definition_size = command->definition_filled = 0;
        /* A failed spawn never permits another start for this identity. Global
         * shutdown owns any child left at its pre-exec barrier. */
        if (!spawned) return false;
        return broker_reply(broker, request, "status", 0, "{\"state\":\"supervisor_started\",\"released\":false}");
    }
    if (!command->launched || command->exited)
        return broker_error(broker, request, "supervisor_unavailable");
    if (request->kind == BROKER_CONTROL) {
        if (request->offset || command->control < 0 || command->control_request[0] ||
            request->size >= 48 || memchr(request->payload, 0, request->size))
            return broker_error(broker, request, "control_unavailable");
        char action[48];
        memcpy(action, request->payload, request->size); action[request->size] = 0;
        const char *receipt = "-";
        if (!strncmp(action, "ack\t", 4) && broker_uuid(action + 4)) {
            receipt = action + 4; action[3] = 0;
        } else if (strcmp(action, "status") && strcmp(action, "release") && strcmp(action, "cancel"))
            return broker_error(broker, request, "invalid_control");
        char frame[FRAME_SIZE];
        int size = snprintf(frame, sizeof(frame), "%s\t%s\t%s\t%s\t%s",
            command->pty ? CHANNEL_PTY_PROTOCOL : CHANNEL_PROTOCOL, command->id, command->nonce, action, receipt);
        if (size <= 0 || (size_t)size >= sizeof(frame)) return false;
        ssize_t sent = send(command->control, frame, (size_t)size, MSG_DONTWAIT | MSG_NOSIGNAL);
        if (sent < 0 && (errno == EAGAIN || errno == EWOULDBLOCK))
            return broker_error(broker, request, "control_pressure");
        if (sent != size) return false;
        memcpy(command->control_request, request->request_id, 37);
        command->control_epoch = request->epoch;
        return true;
    }
    if (request->kind == BROKER_STDIN) {
        if (command->input < 0 || command->input_eof || command->input_size || !request->size ||
            request->offset != command->input_offset)
            return broker_error(broker, request, "stdin_unavailable");
        if (request->size > BROKER_COMMAND_MEMORY - broker->command_memory)
            return broker_error(broker, request, "command_memory_pressure");
        command->pending_input = malloc(request->size);
        if (!command->pending_input) return broker_error(broker, request, "command_memory_pressure");
        memcpy(command->pending_input, request->payload, request->size);
        command->input_size = request->size; command->input_written = 0;
        broker->command_memory += request->size;
        command->input_epoch = request->epoch;
        memcpy(command->input_request, request->request_id, 37);
        return true;
    }
    if (request->kind == BROKER_EOF) {
        if (request->size || request->offset != command->input_offset || command->input_size || command->pty)
            return broker_error(broker, request, command->pty ? "pty_half_close_unsupported" : "invalid_eof");
        broker_close(&command->input); command->input_eof = true;
        return broker_reply(broker, request, "status", command->input_offset, "{\"stdinClosed\":true}");
    }
    if (request->kind == BROKER_RESIZE) {
        if (!command->pty || command->input < 0 || request->offset || request->size != 4)
            return broker_error(broker, request, "invalid_resize");
        struct winsize dimensions = {
            .ws_row = (unsigned short)((unsigned int)request->payload[0] << 8 | request->payload[1]),
            .ws_col = (unsigned short)((unsigned int)request->payload[2] << 8 | request->payload[3])};
        if (!dimensions.ws_row || !dimensions.ws_col || ioctl(command->input, TIOCSWINSZ, &dimensions))
            return broker_error(broker, request, "resize_unavailable");
        return broker_reply(broker, request, "status", 0, "{\"resized\":true}");
    }
    return broker_error(broker, request, "invalid_command_operation");
}

static bool broker_hello(struct broker *broker, const struct broker_request *request) {
    char body[768];
    int size = snprintf(body, sizeof(body),
        "{\"protocol\":\"%s\",\"sealedExec\":\"execveat\",\"pipeCapability\":\"%s\","
        "\"ptyCapability\":\"%s\",\"artifact\":{\"byteSize\":%zu,\"target\":\"%s\","
        "\"seals\":%d,\"device\":\"%ju\",\"inode\":\"%ju\"}}", BROKER_PROTOCOL,
        CHANNEL_PROTOCOL, CHANNEL_PTY_PROTOCOL, broker->facts.size, broker->facts.target,
        broker->facts.seals, broker->facts.device, broker->facts.inode);
    return size > 0 && (size_t)size < sizeof(body) && broker_reply(broker, request, "hello", 0, body);
}

static bool broker_dispatch(struct broker *broker, const struct broker_request *request) {
    if (!request->broker_level) return broker_command_request(broker, request);
    if (request->size) return broker_error(broker, request, "invalid_broker_operation");
    switch (request->kind) {
        case BROKER_FENCE:
            return broker_reply(broker, request, "status", 0, "{\"fenced\":true}");
        case BROKER_HELLO:
            return !request->offset ? broker_hello(broker, request) : broker_error(broker, request, "invalid_hello");
        case BROKER_ACK:
            return broker_output_acknowledge(&broker->output, request->offset) ?
                true : broker_error(broker, request, "invalid_output_ack");
        case BROKER_REPLAY:
            return broker_output_replay(&broker->output, request->offset) ?
                true : broker_error(broker, request, "replay_unavailable");
        default:
            return broker_error(broker, request, "invalid_broker_operation");
    }
}

/* Per-tick observation is bounded. A full data window stops data reads, not
 * control, pidfd observation or cancellation. The reserved window still has a
 * hard cap: if host retention stops, this loop does not invent acknowledgement. */
static bool broker_observe(struct broker *broker, struct broker_command *command) {
    if (!command->launched) return true;
    bool replies = broker->output.bytes <= BROKER_OUTPUT_MAX_BYTES - BROKER_REPLY_SPACE;
    if (command->control >= 0 && command->control_request[0] && replies) {
        char response[FRAME_SIZE];
        ssize_t count = recv(command->control, response, sizeof(response) - 1, MSG_TRUNC | MSG_DONTWAIT);
        if (count > 0) {
            if (count >= (ssize_t)sizeof(response) - 1 || memchr(response, 0, (size_t)count)) return false;
            response[count] = 0;
            if (!broker_output_append(&broker->output, broker->input.broker_id, command->control_epoch,
                command->control_request, command->id, "status", 0, (unsigned char *)response, (size_t)count, true))
                return false;
            command->control_request[0] = 0;
        } else if (count == 0) {
            static const unsigned char body[] = "{\"error\":\"control_outcome_unknown\"}";
            if (!broker_output_append(&broker->output, broker->input.broker_id, command->control_epoch,
                command->control_request, command->id, "error", 0, body, sizeof(body) - 1, true)) return false;
            command->control_request[0] = 0;
            broker_close(&command->control);
        }
        else if (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) return false;
    }
    if (command->input_size && replies) {
        ssize_t count = write(command->input, command->pending_input + command->input_written,
                              command->input_size - command->input_written);
        if (count > 0) {
            command->input_written += (size_t)count;
            command->input_offset += (uint64_t)count;
        } else if (count <= 0 && !(count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR))) {
            broker_close(&command->input); command->input_eof = true;
        }
        if (command->input_written == command->input_size || command->input < 0) {
            const char *body = command->input < 0 ? "{\"error\":\"stdin_closed\"}" : "{\"stdinWritten\":true}";
            if (!broker_output_append(&broker->output, broker->input.broker_id, command->input_epoch,
                command->input_request, command->id, command->input < 0 ? "error" : "status", command->input_offset,
                (const unsigned char *)body, strlen(body), true)) return false;
            free(command->pending_input); command->pending_input = NULL;
            broker->command_memory -= command->input_size;
            command->input_size = command->input_written = 0;
        }
    }
    for (int stream = 0; stream < 2; stream++) {
        if (command->output[stream] >= 0 &&
            broker->output.bytes <= BROKER_OUTPUT_MAX_BYTES - BROKER_OUTPUT_CONTROL_RESERVE - BROKER_FRAME_MAX_BYTES) {
            unsigned char bytes[BROKER_CHUNK_BYTES];
            ssize_t count = read(command->output[stream], bytes, sizeof(bytes));
            if (count > 0) {
                if (!broker_output_append(&broker->output, broker->input.broker_id, command->epoch,
                    command->launch_request, command->id, stream ? "stderr" : "stdout",
                    command->output_offset[stream], bytes, (size_t)count, false)) return false;
                command->output_offset[stream] += (uint64_t)count;
            } else if (count == 0 || (count < 0 && command->pty && errno == EIO)) broker_close(&command->output[stream]);
            else if (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) return false;
        }
        if (command->output[stream] < 0 && !command->eof_reported[stream] && replies) {
            const char *body = stream ? "{\"stream\":\"stderr\",\"eof\":true}" : "{\"stream\":\"stdout\",\"eof\":true}";
            if (!broker_output_append(&broker->output, broker->input.broker_id, command->epoch,
                command->launch_request, command->id, "status", command->output_offset[stream],
                (const unsigned char *)body, strlen(body), true)) return false;
            command->eof_reported[stream] = true;
        }
    }
    if (!command->exited) {
        int status;
        pid_t observed = waitpid(command->pid, &status, WNOHANG);
        if (observed == command->pid) {
            command->exited = true;
            command->exit_code = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
            broker_close(&command->handle);
            /* Unexpected supervisor death can orphan still-writing children
             * into this broker. Fence every admission and drain the whole
             * owned child set instead of letting them outlive their owner. */
            if (command->exit_code != 0) return false;
        } else if (observed < 0 && errno != EINTR) return false;
    }
    if (command->exited && command->eof_reported[0] && command->eof_reported[1] &&
        !command->exit_reported && !command->control_request[0] && replies) {
        char body[128];
        int size = snprintf(body, sizeof(body), "{\"supervisorExitCode\":%d,\"stdoutEof\":true,\"stderrEof\":true}",
                            command->exit_code);
        if (size <= 0 || (size_t)size >= sizeof(body) ||
            !broker_output_append(&broker->output, broker->input.broker_id, command->epoch,
                command->launch_request, command->id, "exit", 0, (unsigned char *)body, (size_t)size, true)) return false;
        command->exit_reported = true;
        broker_close(&command->control); broker_close(&command->input);
        /* Keep the birth tombstone. Never recycle a command ID after exit. */
    }
    return true;
}

static bool broker_wait(struct broker *broker, bool can_read_input) {
    size_t needed = 3;
    for (struct broker_command *command = broker->commands; command; command = command->next)
        if (command->launched && !command->exit_reported) needed += 5;
    if (needed > broker->poll_capacity) {
        struct pollfd *expanded = realloc(broker->polls, needed * sizeof(struct pollfd));
        if (!expanded) return false;
        broker->polls = expanded; broker->poll_capacity = needed;
    }
    size_t count = 0;
    broker->polls[count++] = (struct pollfd){.fd = broker->signals, .events = POLLIN};
    if (can_read_input) broker->polls[count++] = (struct pollfd){.fd = 0, .events = POLLIN};
    for (struct broker_output_frame *frame = broker->output.first; frame; frame = frame->next) {
        if (frame->written < frame->size) {
            broker->polls[count++] = (struct pollfd){.fd = 1, .events = POLLOUT};
            break;
        }
    }
    bool replies = broker->output.bytes <= BROKER_OUTPUT_MAX_BYTES - BROKER_REPLY_SPACE;
    bool data = broker->output.bytes <= BROKER_OUTPUT_MAX_BYTES - BROKER_OUTPUT_CONTROL_RESERVE - BROKER_FRAME_MAX_BYTES;
    for (struct broker_command *command = broker->commands; command; command = command->next) {
        if (!command->launched || command->exit_reported) continue;
        if (command->handle >= 0)
            broker->polls[count++] = (struct pollfd){.fd = command->handle, .events = POLLIN};
        if (replies && command->control >= 0 && command->control_request[0])
            broker->polls[count++] = (struct pollfd){.fd = command->control, .events = POLLIN};
        if (replies && command->input >= 0 && command->input_size)
            broker->polls[count++] = (struct pollfd){.fd = command->input, .events = POLLOUT};
        for (int stream = 0; stream < 2; stream++)
            if (data && command->output[stream] >= 0)
                broker->polls[count++] = (struct pollfd){.fd = command->output[stream], .events = POLLIN};
    }
    /* Only actual readiness wakes the broker. Fully sent/unacknowledged data,
     * tombstones and an idle initial channel cause no periodic CPU wakeups. */
    int result = poll(broker->polls, (nfds_t)count, -1);
    return result >= 0 || errno == EINTR;
}

/* Exceptional initial-channel loss is not clean command settlement. Close all
 * channels, then keep this subreaper alive until positive all-child ECHILD.
 * Whole-broker shutdown may stop all of its children, never unrelated processes.
 * No receipt or clean exit frame is fabricated from this cleanup. */
static int broker_shutdown(struct broker *broker) {
    for (struct broker_command *command = broker->commands; command; command = command->next) {
        broker_close(&command->control); broker_close(&command->input);
    }
    long long started = milliseconds();
    int status = 125; bool seen = false;
    while (!reap(0, &status, &seen)) {
        if (milliseconds() - started >= CANCEL_GRACE_MS) signal_children(SIGKILL);
        (void)poll(NULL, 0, 10);
    }
    while (broker->commands) {
        struct broker_command *command = broker->commands;
        broker->commands = command->next;
        broker_close(&command->handle);
        broker_close(&command->output[0]); broker_close(&command->output[1]);
        free(command->definition); free(command->pending_input); free(command);
    }
    broker_output_free(&broker->output);
    free(broker->polls);
    broker_close(&broker->artifact); broker_close(&broker->signals);
    return 125;
}

static int broker_run(int argc, char **argv) {
    if (argc != 4 || strcmp(argv[2], "--broker-id") || !broker_uuid(argv[3])) fail("invalid broker identity");
    initialize();
    struct broker broker = {.artifact = -1, .signals = -1};
    if (!broker_input_initialize(&broker.input, argv[3])) fail("invalid broker identity");
    broker.artifact = sealed_artifact(&broker.facts);
    if (syscall(SYS_close_range, ~0U, ~0U, 4U /* CLOSE_RANGE_CLOEXEC */))
        fail("broker descriptor isolation unavailable");
    /* Verify both real execution modes before advertising them. Fixed probes
     * execute only sealed helper code, never user setup or a command definition. */
    unsigned char proof[1024];
    size_t size = broker_probe_exec(broker.artifact, "capabilities", NULL, false, proof, sizeof(proof));
    if (size != strlen(PROTOCOL) || memcmp(proof, PROTOCOL, size)) fail("broker pipe proof failed");
    size = broker_probe_exec(broker.artifact, "capabilities", "--pty", true, proof, sizeof(proof));
    if (size != strlen(PTY_PROTOCOL) || memcmp(proof, PTY_PROTOCOL, size)) fail("broker PTY proof failed");
    sigset_t signals;
    sigemptyset(&signals);
    sigaddset(&signals, SIGTERM); sigaddset(&signals, SIGINT); sigaddset(&signals, SIGHUP); sigaddset(&signals, SIGCHLD);
    if (sigprocmask(SIG_BLOCK, &signals, NULL) || signal(SIGPIPE, SIG_IGN) == SIG_ERR ||
        signal(SIGTERM, SIG_DFL) == SIG_ERR || signal(SIGINT, SIG_DFL) == SIG_ERR ||
        signal(SIGHUP, SIG_DFL) == SIG_ERR) fail("broker signals unavailable");
    broker.signals = signalfd(-1, &signals, SFD_CLOEXEC | SFD_NONBLOCK);
    if (broker.signals < 0 || !broker_nonblocking(0) || !broker_nonblocking(1)) fail("broker channels unavailable");
    struct broker_request boot = {.epoch = 1, .broker_level = true};
    memcpy(boot.request_id, argv[3], 37);
    if (!broker_hello(&broker, &boot)) return broker_shutdown(&broker);
    for (size_t offset = 0; offset < broker.facts.size; offset += BROKER_CHUNK_BYTES) {
        unsigned char bytes[BROKER_CHUNK_BYTES];
        size_t count = broker.facts.size - offset;
        if (count > sizeof(bytes)) count = sizeof(bytes);
        read_exact_at(broker.artifact, bytes, count, (off_t)offset);
        if (!broker_output_append(&broker.output, argv[3], 1, argv[3], NULL, "artifact", offset, bytes, count, true))
            return broker_shutdown(&broker);
    }
    unsigned char input[BROKER_FRAME_MAX_BYTES];
    size_t used = 0;
    for (;;) {
        struct pollfd channels[2] = {{.fd = 0, .events = POLLIN}, {.fd = 1, .events = POLLOUT}};
        int channel_state = poll(channels, 2, 0);
        if ((channel_state < 0 && errno != EINTR) ||
            ((channels[0].revents | channels[1].revents) & (POLLHUP | POLLERR | POLLNVAL))) break;
        /* Initial-channel closure wins over already buffered release/input,
         * just as private supervisor-channel closure wins over release. */
        if (!broker_output_flush(&broker.output, 1, 65536)) break;
        struct signalfd_siginfo signal;
        for (;;) {
            ssize_t count = read(broker.signals, &signal, sizeof(signal));
            if (count == (ssize_t)sizeof(signal)) {
                if (signal.ssi_signo != SIGCHLD) return broker_shutdown(&broker);
            } else if (count < 0 && errno == EINTR) continue;
            else if (count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) break;
            else return broker_shutdown(&broker);
        }
        for (struct broker_command *command = broker.commands; command; command = command->next)
            if (!broker_observe(&broker, command)) return broker_shutdown(&broker);
        unsigned char *newline = memchr(input, '\n', used);
        if (newline) {
            size_t length = (size_t)(newline - input) + 1;
            struct broker_input_state next = broker.input;
            struct broker_request request;
            enum broker_input_result accepted = broker_input_accept(&next, input, length, &request);
            if (accepted == BROKER_INPUT_INVALID || accepted == BROKER_INPUT_REJECTED) break;
            if (accepted == BROKER_INPUT_REPLAY) {
                if (!broker_output_replay(&broker.output, broker.output.acknowledged + 1)) goto yield;
            } else {
                /* An ACK may release pressure before its acceptance frame is
                 * appended; it is ordered/validated already, and is idempotent.
                 * Its dispatch below repeats only the same monotonic ACK. */
                if (request.kind == BROKER_ACK && request.broker_level && !request.size)
                    (void)broker_output_acknowledge(&broker.output, request.offset);
                /* Exhausting even the reserved response window is a broken
                 * retention/control channel, not permission to drop evidence
                 * or hold a pending input forever while the host awaits ACK. */
                if (broker.output.bytes > BROKER_OUTPUT_MAX_BYTES - BROKER_REPLY_SPACE) break;
                broker.input = next;
                if (!broker_reply(&broker, &request, "accepted", request.sequence, "") ||
                    !broker_dispatch(&broker, &request)) break;
            }
            memmove(input, input + length, used - length); used -= length;
            continue;
        }
        if (used == sizeof(input)) break;
        ssize_t count = read(0, input + used, sizeof(input) - used);
        if (count > 0) { used += (size_t)count; continue; }
        if (count == 0 || (errno != EINTR && errno != EAGAIN && errno != EWOULDBLOCK)) break;
yield:
        if (!broker_wait(&broker, !newline)) break;
    }
    return broker_shutdown(&broker);
}

int main(int argc, char **argv) {
    if (argc >= 2 && !strcmp(argv[1], "broker")) return broker_run(argc, argv);
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

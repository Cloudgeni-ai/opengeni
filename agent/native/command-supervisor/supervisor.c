/* Linux, single-threaded, per-invocation subreaper. Not a hostile-code boundary.
 * The control socket is never inherited by user code. Only kernel ECHILD after
 * launch has permanently closed authorizes a receipt; procfs is discovery only.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/random.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define PROTOCOL "native-subreaper-v1"
#define FRAME_SIZE 1024
#define CANCEL_GRACE_MS 200

struct options {
    const char *invocation, *nonce, *path, *action, *receipt;
    char **command;
    bool launch;
};

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

static struct options parse(int argc, char **argv) {
    struct options o = {0};
    if (argc < 2) fail("missing subcommand");
    o.launch = !strcmp(argv[1], "launch");
    if (!o.launch && strcmp(argv[1], "control")) fail("invalid subcommand");
    for (int i = 2; i < argc; i++) {
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
    snprintf(frame, sizeof(frame), "%s\t%s\t%s\t%s\t%s", PROTOCOL, o->invocation,
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

static int launch(const struct options *o) {
    initialize(); /* All required primitives checked before any user code. */
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
    int leader_exit = 125; /* Cancelled before release: no leader was launched. */
    long long cancel_at = 0;
    char receipt_id[37], response[FRAME_SIZE];
    make_receipt_id(receipt_id);
    for (;;) {
        if (!quiescent && (started || cancelled)) {
            if (cancelled) signal_children(milliseconds() - cancel_at < CANCEL_GRACE_MS ? SIGTERM : SIGKILL);
            if (reap(leader, &leader_exit, &leader_seen)) {
                if (started && !leader_seen) fail("leader status missing");
                quiescent = true;
                snprintf(response, sizeof(response),
                    "{\"state\":\"quiescent\",\"receipt\":{\"protocol\":\"%s\",\"invocationId\":\"%s\","
                    "\"receiptId\":\"%s\",\"leaderExitCode\":%d}}", PROTOCOL, o->invocation, receipt_id, leader_exit);
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
        valid = valid && !position && !strcmp(fields[0], PROTOCOL) &&
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
                leader = fork();
                if (leader < 0) fail("leader fork failed");
                if (!leader) {
                    close(client);
                    close(listener);
                    /* No supervisor-owned pidfds exist across fork. CLOEXEC on
                     * all private descriptors is defense in depth, not proof. */
                    execvp(o->command[0], o->command);
                    _exit(127);
                }
                started = true;
                int fd = pidfd_open_child(leader);
                close(fd);
            }
            send_frame(client, quiescent ? response :
                (started || cancelled ? "{\"state\":\"running\"}" : "{\"state\":\"idle\"}"));
        }
        close(client);
        if (ack) {
            close(listener);
            /* Control housekeeping only; never mutate /workspace after proof. */
            if (unlink(o->path)) fail("control cleanup failed");
            return 0;
        }
    }
}

int main(int argc, char **argv) {
    /* Bounded capability check: exercise the same kernel prerequisites as
     * launch, but create no socket, child or persistent supervisor. */
    if (argc == 2 && !strcmp(argv[1], "capabilities")) {
        initialize();
        printf("%s", PROTOCOL);
        return 0;
    }
    struct options o = parse(argc, argv);
    return o.launch ? launch(&o) : control(&o);
}
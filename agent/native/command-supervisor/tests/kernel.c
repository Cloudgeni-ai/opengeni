/* Exercise the actual production reaper with a direct non-SIGCHLD clone child.
 * Adoption can change a descendant's exit signal, so the end-to-end clone
 * fixture alone cannot prove that the all-child wait includes clone children.
 */
#define _GNU_SOURCE
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <termios.h>
#include <unistd.h>
static int test_tcsetpgrp(int terminal, pid_t group);
static int test_setpgid(pid_t pid, pid_t group);
static int test_ioctl(int fd, unsigned long request, void *argument);
static int test_fstat(int fd, struct stat *attributes);
#define tcsetpgrp test_tcsetpgrp
#define setpgid test_setpgid
#define ioctl test_ioctl
#define fstat test_fstat
#define main supervisor_cli_main
#include "../supervisor.c"
#undef main
#undef tcsetpgrp
#undef setpgid
#undef ioctl
#undef fstat
#include <assert.h>
#include <sched.h>

/* Deterministic injection lives only in this separately built test executable,
 * never in production flags/environment. The real terminal ioctls still run. */
static const char *test_mode;
static int identity_terminal = -1;

static int test_ioctl(int fd, unsigned long request, void *argument) {
    if (test_mode && request == TIOCGDEV && !strncmp(test_mode, "identity-", 9)) {
        identity_terminal = fd;
        errno = !strcmp(test_mode, "identity-denied") ? EPERM : ENOTTY;
        return -1;
    }
    return ioctl(fd, request, argument);
}

static int test_fstat(int fd, struct stat *attributes) {
    /* Model kernels where /dev/tty opens the terminal inode, including on
     * Linux hosts where the real /dev/tty descriptor is instead a proxy. */
    if (fd == identity_terminal && test_mode && !strcmp(test_mode, "identity-inode"))
        return fstat(STDIN_FILENO, attributes);
    int result = fstat(fd, attributes);
    if (!result && fd == identity_terminal && test_mode &&
        !strcmp(test_mode, "identity-mismatch")) attributes->st_ino ^= 1;
    return result;
}

static int test_tcsetpgrp(int terminal, pid_t group) {
    if (test_mode && !strcmp(test_mode, "handoff-failure") && group != getpgrp()) {
        errno = EPERM;
        return -1;
    }
    int result = tcsetpgrp(terminal, group);
    if (!result && test_mode && !strcmp(test_mode, "handoff-signal") && group != getpgrp()) {
        int handle = pidfd_open_child(group);
        signal_handle(handle, SIGINT);
        close(handle);
        siginfo_t info = {0};
        assert(waitid(P_PID, (id_t)group, &info, WEXITED | WNOWAIT | __WALL) == 0);
        assert(info.si_code == CLD_KILLED && info.si_status == SIGINT);
    }
    return result;
}

static int test_setpgid(pid_t pid, pid_t group) {
    int result = setpgid(pid, group);
    if (!result && test_mode && !strcmp(test_mode, "stop-before-ready")) {
        int handle = pidfd_open_child(getpid());
        signal_handle(handle, SIGSTOP);
        close(handle);
    }
    return result;
}

static int delayed_exit(void *unused) {
    (void)unused;
    usleep(150000);
    return 37;
}

int main(int argc, char **argv) {
    if (argc > 2) {
        test_mode = argv[1];
        assert(!strcmp(test_mode, "handoff-signal") || !strcmp(test_mode, "stop-before-ready") ||
               !strcmp(test_mode, "handoff-failure") || !strcmp(test_mode, "identity-inode") ||
               !strcmp(test_mode, "identity-mismatch") || !strcmp(test_mode, "identity-denied"));
        return supervisor_cli_main(argc - 1, &argv[1]);
    }
    struct sigaction inherited = {.sa_handler = SIG_IGN, .sa_flags = SA_NOCLDWAIT};
    sigemptyset(&inherited.sa_mask);
    assert(sigaction(SIGCHLD, &inherited, NULL) == 0);
    initialize();
    struct sigaction actual;
    assert(sigaction(SIGCHLD, NULL, &actual) == 0);
    assert(actual.sa_handler == SIG_DFL && !(actual.sa_flags & SA_NOCLDWAIT));
    void *stack = malloc(65536);
    assert(stack);
    pid_t child = clone(delayed_exit, (char *)stack + 65536, 0, NULL);
    assert(child > 0);
    /* Demonstrate why an ordinary wait is not the proof. */
    assert(waitpid(-1, NULL, WNOHANG) == -1 && errno == ECHILD);
    bool seen = false;
    int code = 0;
    assert(!reap(child, &code, &seen));
    long long deadline = milliseconds() + 3000;
    while (!reap(child, &code, &seen)) {
        assert(milliseconds() < deadline);
        usleep(1000);
    }
    assert(seen && code == 37);
    free(stack);
    puts("direct clone __WALL and inherited SIGCHLD reset passed");
    return 0;
}

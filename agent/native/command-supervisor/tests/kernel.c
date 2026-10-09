/* Exercise the actual production reaper with a direct non-SIGCHLD clone child.
 * Adoption can change a descendant's exit signal, so the end-to-end clone
 * fixture alone cannot prove that the all-child wait includes clone children.
 */
#define _GNU_SOURCE
#include <termios.h>
#include <unistd.h>
static int test_tcsetpgrp(int terminal, pid_t group);
static int test_setpgid(pid_t pid, pid_t group);
#define tcsetpgrp test_tcsetpgrp
#define setpgid test_setpgid
#define main supervisor_cli_main
#include "../supervisor.c"
#undef main
#undef tcsetpgrp
#undef setpgid
#include <assert.h>
#include <sched.h>

/* Deterministic injection lives only in this separately built test executable,
 * never in production flags/environment. The real terminal ioctls still run. */
static const char *test_mode;

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
               !strcmp(test_mode, "handoff-failure"));
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

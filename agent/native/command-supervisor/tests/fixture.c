#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <sched.h>
#include <signal.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

static const char *marker;

static void tick(void) {
    int fd = open(marker, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0600);
    if (fd < 0 || write(fd, ".", 1) != 1) _exit(90);
    close(fd);
}

static void writer(void) {
    for (int i = 0; i < 600; i++) { tick(); usleep(5000); }
    _exit(0);
}

static void fork_on_term(int signal_number) {
    (void)signal_number;
    if (fork() == 0) {
        signal(SIGTERM, SIG_IGN);
        writer();
    }
    _exit(0);
}

static int clone_writer(void *unused) {
    (void)unused;
    signal(SIGTERM, SIG_IGN);
    writer();
    return 0;
}

static void deny_syscall(int nr) {
    struct sock_filter instructions[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (unsigned int)nr, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (unsigned int)ENOSYS),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    };
    struct sock_fprog program = {.len = 4, .filter = instructions};
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) ||
        prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program)) exit(91);
}

static int stale_pidfd(void) {
    pid_t child = fork();
    if (child == 0) _exit(0);
    if (child < 0) return 92;
    int fd = (int)syscall(SYS_pidfd_open, child, 0);
    if (fd < 0 || waitpid(child, NULL, 0) != child) return 93;
    pid_t unrelated = fork();
    if (unrelated == 0) { usleep(200000); _exit(23); }
    if (unrelated < 0) return 94;
    errno = 0;
    long sent = syscall(SYS_pidfd_send_signal, fd, SIGKILL, NULL, 0);
    int error = errno;
    close(fd);
    int status;
    if (waitpid(unrelated, &status, 0) != unrelated) return 95;
    return sent == -1 && error == ESRCH && WIFEXITED(status) && WEXITSTATUS(status) == 23 ? 0 : 96;
}

int main(int argc, char **argv) {
    if (argc < 2) return 80;
    const char *mode = argv[1];
    if (!strcmp(mode, "stale-pidfd")) return stale_pidfd();
    if (!strcmp(mode, "sigchld-inherit")) {
        struct sigaction action = {.sa_handler = SIG_IGN, .sa_flags = SA_NOCLDWAIT};
        sigemptyset(&action.sa_mask);
        if (sigaction(SIGCHLD, &action, NULL)) return 81;
        sigset_t set;
        sigfillset(&set);
        if (sigprocmask(SIG_SETMASK, &set, NULL)) return 82;
        execvp(argv[2], &argv[2]);
        return 83;
    }
    if (!strncmp(mode, "deny-", 5)) {
        int nr = !strcmp(mode, "deny-pidfd") ? SYS_pidfd_open :
            !strcmp(mode, "deny-send") ? SYS_pidfd_send_signal :
            !strcmp(mode, "deny-wait") ? SYS_waitid : SYS_prctl;
        deny_syscall(nr);
        execvp(argv[2], &argv[2]);
        return 84;
    }
    if (argc != 3) return 85;
    marker = argv[2];
    if (!strcmp(mode, "signal-check")) {
        struct sigaction action;
        sigset_t mask;
        if (sigaction(SIGCHLD, NULL, &action) || sigprocmask(SIG_SETMASK, NULL, &mask)) return 86;
        if (action.sa_handler != SIG_DFL || (action.sa_flags & SA_NOCLDWAIT) || sigismember(&mask, SIGCHLD)) return 87;
        tick();
        return 19;
    }
    if (!strcmp(mode, "leader-first") || !strcmp(mode, "double-fork")) {
        pid_t child = fork();
        if (child < 0) return 88;
        if (child) return 17;
        if (!strcmp(mode, "double-fork")) {
            if (setsid() < 0) return 89;
            child = fork();
            if (child < 0) return 88;
            if (child) _exit(0);
        }
        signal(SIGTERM, SIG_IGN);
        writer();
    }
    if (!strcmp(mode, "clone")) {
        void *stack = malloc(65536);
        if (!stack || clone(clone_writer, (char *)stack + 65536, 0, NULL) < 0) return 88;
        /* Keep this parent alive briefly: normal waits filter the zero-signal
         * clone child. After exit, the subreaper must adopt and reap it. */
        usleep(50000);
        return 18;
    }
    if (!strcmp(mode, "fork-on-term")) {
        signal(SIGTERM, fork_on_term);
        writer();
    }
    if (!strcmp(mode, "fork-many")) {
        signal(SIGTERM, SIG_IGN);
        for (int i = 0; i < 100; i++) {
            if (fork() == 0) writer();
            usleep(10000);
        }
        writer();
    }
    if (!strcmp(mode, "ignore-term")) {
        signal(SIGTERM, SIG_IGN);
        writer();
    }
    if (!strcmp(mode, "natural-descendant")) {
        pid_t child = fork();
        if (child < 0) return 88;
        if (child) return 21;
        for (int i = 0; i < 50; i++) { tick(); usleep(5000); }
        return 0;
    }
    if (!strcmp(mode, "fd-check")) {
        /* Launch listener and accepted control connection must both be closed. */
        for (int fd = 3; fd < 64; fd++) if (fcntl(fd, F_GETFD) >= 0) return 97;
        tick();
        return 0;
    }
    return 99;
}
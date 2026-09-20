/* Exercise the actual production reaper with a direct non-SIGCHLD clone child.
 * Adoption can change a descendant's exit signal, so the end-to-end clone
 * fixture alone cannot prove that the all-child wait includes clone children.
 */
#define main supervisor_cli_main
#include "../supervisor.c"
#undef main
#include <assert.h>
#include <sched.h>

static int delayed_exit(void *unused) {
    (void)unused;
    usleep(150000);
    return 37;
}

int main(void) {
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
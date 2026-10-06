/* Synthetic Linux syscall barriers for the Bun journal conformance suite. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <limits.h>
#include <spawn.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static bool terminal_path(const char *path) {
    const char *name = strrchr(path, '/');
    return !strcmp(name ? name + 1 : path, "terminal.json");
}

static void note(const char *event) {
    const char *path = getenv("CONFORMANCE_SYNC_TRACE");
    if (!path) return;
    int fd = open(path, O_CREAT | O_APPEND | O_WRONLY | O_CLOEXEC, 0600);
    if (fd < 0) _exit(91);
    if (write(fd, event, strlen(event)) != (ssize_t)strlen(event) || write(fd, "\n", 1) != 1) _exit(92);
    close(fd);
}

static void published(int result, const char *path) {
    const char *gate = getenv("CONFORMANCE_TERMINAL_LINK_GATE");
    if (result || !gate || !terminal_path(path)) return;
    int fd = open(gate, O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0600);
    if (fd < 0) _exit(93);
    close(fd);
    // Parent kills this exact paused publisher after a peer has settled history.
    for (;;) pause();
}

int link(const char *old, const char *path) {
    int (*original)(const char *, const char *) = dlsym(RTLD_NEXT, "link");
    if (!original) _exit(94);
    int result = original(old, path);
    published(result, path);
    return result;
}

int linkat(int olddir, const char *old, int newdir, const char *path, int flags) {
    int (*original)(int, const char *, int, const char *, int) = dlsym(RTLD_NEXT, "linkat");
    if (!original) _exit(94);
    int result = original(olddir, old, newdir, path, flags);
    published(result, path);
    return result;
}

int fsync(int fd) {
    int (*original)(int) = dlsym(RTLD_NEXT, "fsync");
    if (!original) _exit(94);
    int result = original(fd);
    if (!result && getenv("CONFORMANCE_SYNC_TRACE")) {
        char descriptor[64], path[PATH_MAX];
        snprintf(descriptor, sizeof(descriptor), "/proc/self/fd/%d", fd);
        ssize_t n = readlink(descriptor, path, sizeof(path) - 1);
        if (n >= 0) {
            path[n] = 0;
            if (terminal_path(path)) note("terminal_fsync");
            const char *directory = getenv("CONFORMANCE_OPERATION_DIRECTORY");
            if (directory && !strcmp(directory, path)) note("operation_dir_fsync");
        }
    }
    return result;
}

int posix_spawnp(pid_t *pid, const char *file, const posix_spawn_file_actions_t *actions,
                 const posix_spawnattr_t *attributes, char *const argv[], char *const env[]) {
    int (*original)(pid_t *, const char *, const posix_spawn_file_actions_t *,
        const posix_spawnattr_t *, char *const [], char *const []) = dlsym(RTLD_NEXT, "posix_spawnp");
    if (!original) _exit(94);
    for (size_t i = 0; argv[i] && argv[i + 1]; i++) {
        if (!strcmp(argv[i], "--action") && !strcmp(argv[i + 1], "ack")) note("native_ack");
    }
    return original(pid, file, actions, attributes, argv, env);
}

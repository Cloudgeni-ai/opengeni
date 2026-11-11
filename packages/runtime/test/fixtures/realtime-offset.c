// Linux-only isolated native-probe shim. Alters this process's wall clock and
// optional suspend-inclusive clock, never CLOCK_MONOTONIC or the host clock.
// Compile with cc -shared -fPIC ... -ldl.
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdlib.h>
#include <time.h>
#include <unistd.h>

static int (*real_clock_gettime)(clockid_t, struct timespec *);

__attribute__((constructor)) static void initialize_clock(void) {
    real_clock_gettime = dlsym(RTLD_NEXT, "clock_gettime");
    if (!real_clock_gettime) _exit(127);
}

int clock_gettime(clockid_t clock, struct timespec *value) {
    int result = real_clock_gettime(clock, value);
    const char *path = clock == CLOCK_REALTIME ? getenv("OPENGENI_TEST_CLOCK_OFFSET_FILE")
        : clock == CLOCK_BOOTTIME ? getenv("OPENGENI_TEST_BOOT_OFFSET_FILE") : NULL;
    if (result == 0 && path) {
        int fd = open(path, O_RDONLY);
        if (fd >= 0) {
            char buffer[32] = {0};
            ssize_t count = read(fd, buffer, sizeof(buffer) - 1);
            close(fd);
            if (count > 0) value->tv_sec += strtol(buffer, NULL, 10);
        }
    }
    return result;
}

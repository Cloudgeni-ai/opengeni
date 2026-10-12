/* Test-only output queue driver. No command dispatch or provider admission. */
#define main supervisor_cli_main
#include "../supervisor.c"
#undef main

#define CHECK(condition) do { if (!(condition)) { \
    fprintf(stderr, "queue assertion failed at line %d\n", __LINE__); return 1; \
} } while (0)

static const char *broker = "11111111-1111-4111-8111-111111111111";
static const char *request = "22222222-2222-4222-8222-222222222222";
static const char *command = "33333333-3333-4333-8333-333333333333";

static bool pair(int channel[2]) {
    if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0, channel)) return false;
    int capacity = 4096;
    return setsockopt(channel[0], SOL_SOCKET, SO_SNDBUF, &capacity, sizeof(capacity)) == 0;
}

static bool append(struct broker_output_queue *queue, const char *kind,
                   const unsigned char *payload, size_t size, bool control) {
    return broker_output_append(queue, broker, 1, request, command, kind, 0, payload, size, control);
}

static ssize_t drain(int fd, unsigned char *bytes, size_t size) {
    size_t total = 0;
    while (total < size) {
        ssize_t count = read(fd, bytes + total, size - total);
        if (count < 0 && errno == EINTR) continue;
        if (count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) break;
        if (count <= 0) return -1;
        total += (size_t)count;
    }
    return (ssize_t)total;
}

static bool deliver(struct broker_output_queue *queue, int channel[2],
                    unsigned char *bytes, size_t size) {
    size_t total = 0;
    /* Each pass is bounded; this cap is only a test hang guard. */
    for (size_t iteration = 0; total < size && iteration < 10000; iteration++) {
        if (!broker_output_flush(queue, channel[0], 16384)) return false;
        ssize_t count = drain(channel[1], bytes + total, size - total);
        if (count < 0) return false;
        total += (size_t)count;
    }
    return total == size;
}

static int binary(void) {
    struct broker_output_queue queue = {0};
    unsigned char payload[BROKER_CHUNK_BYTES];
    for (size_t i = 0; i < sizeof(payload); i++) payload[i] = (unsigned char)i;
    CHECK(append(&queue, "stdout", payload, sizeof(payload), false));
    CHECK(broker_output_append(&queue, broker, BROKER_SAFE_INTEGER, request, NULL,
                              "status", BROKER_SAFE_INTEGER, NULL, 0, true));
    CHECK(fwrite(queue.first->bytes, 1, queue.first->size, stdout) == queue.first->size);
    CHECK(fwrite(queue.last->bytes, 1, queue.last->size, stdout) == queue.last->size);
    broker_output_free(&queue);
    return 0;
}

static int budget_and_ack(void) {
    int channel[2];
    CHECK(pair(channel));
    struct broker_output_queue queue = {0};
    CHECK(append(&queue, "stdout", (const unsigned char *)"one", 3, false));
    CHECK(append(&queue, "stderr", (const unsigned char *)"two", 3, false));
    size_t first_size = queue.first->size, second_size = queue.last->size;
    size_t size = first_size + second_size;
    unsigned char expected[1024], actual[1024];
    CHECK(size < sizeof(expected));
    memcpy(expected, queue.first->bytes, first_size);
    memcpy(expected + first_size, queue.last->bytes, second_size);
    CHECK(!broker_output_acknowledge(&queue, 1));
    CHECK(broker_output_flush(&queue, channel[0], 0));
    CHECK(queue.first->written == 0);
    CHECK(broker_output_flush(&queue, channel[0], 17));
    CHECK(queue.first->written == 17 && queue.last->written == 0 && queue.sent_through == 0);
    CHECK(!broker_output_replay(&queue, 1));
    CHECK(!broker_output_acknowledge(&queue, 1));
    CHECK(drain(channel[1], actual, sizeof(actual)) == 17);
    CHECK(deliver(&queue, channel, actual + 17, size - 17));
    CHECK(!memcmp(actual, expected, size));
    CHECK(queue.first && queue.sent_through == 2); /* sent is not retained by host */
    CHECK(!broker_output_acknowledge(&queue, 3));
    CHECK(broker_output_acknowledge(&queue, 1));
    CHECK(queue.first == queue.last && queue.first->sequence == 2);
    CHECK(!broker_output_acknowledge(&queue, 0));
    CHECK(broker_output_acknowledge(&queue, 2));
    CHECK(!queue.first && !queue.last && queue.bytes == 0);
    CHECK(broker_output_acknowledge(&queue, 2));
    CHECK(broker_output_replay(&queue, 3)); /* empty retained suffix is a no-op */
    CHECK(append(&queue, "exit", NULL, 0, true) && queue.sequence == 3);
    broker_output_free(&queue);
    CHECK(!queue.first && !queue.last && !queue.bytes && !queue.sequence);
    close(channel[0]); close(channel[1]);
    return 0;
}

static int replay_partial_ack(void) {
    int channel[2];
    CHECK(pair(channel));
    struct broker_output_queue queue = {0};
    CHECK(append(&queue, "stdout", (const unsigned char *)"one", 3, false));
    CHECK(append(&queue, "stderr", (const unsigned char *)"two", 3, false));
    size_t first_size = queue.first->size, size = first_size + queue.last->size;
    unsigned char original[1024], replay[1024];
    CHECK(size < sizeof(original) && deliver(&queue, channel, original, size));
    CHECK(!broker_output_replay(&queue, 0) && !broker_output_replay(&queue, 2));
    CHECK(broker_output_replay(&queue, 1));
    CHECK(queue.first->written == 0 && queue.last->written == 0);
    CHECK(broker_output_flush(&queue, channel[0], 13));
    CHECK(drain(channel[1], replay, sizeof(replay)) == 13);
    CHECK(broker_output_acknowledge(&queue, 2));
    CHECK(queue.first && queue.first->written == 13 && queue.last); /* incomplete replay survives */
    CHECK(!broker_output_replay(&queue, 3));
    CHECK(broker_output_flush(&queue, channel[0], first_size - 13));
    CHECK(drain(channel[1], replay + 13, sizeof(replay) - 13) == (ssize_t)(first_size - 13));
    CHECK(!memcmp(original, replay, first_size));
    CHECK(!queue.first && !queue.last && !queue.bytes);
    CHECK(append(&queue, "exit", NULL, 0, true));
    CHECK(deliver(&queue, channel, replay, queue.last->size));
    CHECK(!memcmp(replay, "OGB1\tresponse\t", 14));
    broker_output_free(&queue);
    close(channel[0]); close(channel[1]);
    return 0;
}

static int pressure(void) {
    int channel[2];
    CHECK(pair(channel));
    struct broker_output_queue queue = {0};
    unsigned char payload[BROKER_CHUNK_BYTES] = {0};
    while (append(&queue, "stdout", payload, sizeof(payload), false)) {}
    CHECK(queue.sequence > 100 && queue.bytes <= BROKER_OUTPUT_MAX_BYTES - BROKER_OUTPUT_CONTROL_RESERVE);
    uint64_t data_frames = queue.sequence;
    size_t data_bytes = queue.bytes;
    CHECK(!append(&queue, "stdout", payload, sizeof(payload), true));
    CHECK(!append(&queue, "stderr", payload, sizeof(payload), true));
    CHECK(queue.sequence == data_frames && queue.bytes == data_bytes);
    CHECK(append(&queue, "status", payload, sizeof(payload), true));
    while (append(&queue, "status", payload, sizeof(payload), true)) {}
    CHECK(queue.sequence > data_frames && queue.bytes <= BROKER_OUTPUT_MAX_BYTES);
    size_t size = 0;
    for (struct broker_output_frame *frame = queue.first; frame; frame = frame->next) size += frame->size;
    unsigned char *expected = malloc(size), *actual = malloc(size);
    CHECK(expected && actual);
    size_t offset = 0;
    for (struct broker_output_frame *frame = queue.first; frame; frame = frame->next) {
        memcpy(expected + offset, frame->bytes, frame->size);
        offset += frame->size;
    }
    /* A full pipe must yield repeatedly, not block or discard a frame. */
    for (int i = 0; i < 100; i++) CHECK(broker_output_flush(&queue, channel[0], 65536));
    CHECK(queue.sent_through < queue.sequence && queue.first && queue.bytes > data_bytes);
    CHECK(deliver(&queue, channel, actual, size));
    CHECK(!memcmp(actual, expected, size));
    CHECK(queue.sent_through == queue.sequence);
    CHECK(broker_output_acknowledge(&queue, queue.sequence));
    CHECK(!queue.first && !queue.bytes);
    free(expected); free(actual);
    broker_output_free(&queue);
    close(channel[0]); close(channel[1]);
    return 0;
}

static int failure(void) {
    int channel[2];
    CHECK(pair(channel));
    struct broker_output_queue queue = {0};
    CHECK(append(&queue, "error", NULL, 0, true));
    int flags = fcntl(channel[0], F_GETFL);
    CHECK(flags >= 0 && fcntl(channel[0], F_SETFL, flags & ~O_NONBLOCK) == 0);
    CHECK(!broker_output_flush(&queue, channel[0], 1024) && !queue.first->written);
    CHECK(fcntl(channel[0], F_SETFL, flags) == 0);
    close(channel[1]);
    CHECK(!broker_output_flush(&queue, channel[0], 1024));
    CHECK(!queue.first->written && !queue.sent_through && !queue.acknowledged);
    CHECK(!broker_output_acknowledge(&queue, 1));
    CHECK(!broker_output_flush(&queue, -1, 1024));
    broker_output_free(&queue);
    close(channel[0]);
    return 0;
}

static int boundaries(void) {
    struct broker_output_queue queue = {0}, zero = {0};
    unsigned char payload[BROKER_CHUNK_BYTES + 1] = {0};
    CHECK(!append(&queue, "stdin", NULL, 0, true));
    CHECK(!append(&queue, "hello", payload, sizeof(payload), true));
    CHECK(!broker_output_append(&queue, broker, 0, request, NULL, "hello", 0, NULL, 0, true));
    CHECK(!broker_output_append(&queue, broker, 1, request, "bad", "hello", 0, NULL, 0, true));
    CHECK(!broker_output_append(&queue, broker, 1, request, NULL, "hello",
                                BROKER_SAFE_INTEGER, payload, 1, true));
    CHECK(!memcmp(&queue, &zero, sizeof(queue)));
    queue.sequence = BROKER_SAFE_INTEGER - 1;
    queue.sent_through = queue.acknowledged = queue.sequence;
    CHECK(append(&queue, "hello", NULL, 0, true));
    CHECK(queue.sequence == BROKER_SAFE_INTEGER);
    size_t bytes = queue.bytes;
    CHECK(!append(&queue, "hello", NULL, 0, true) && queue.bytes == bytes);
    CHECK(!broker_output_acknowledge(&queue, queue.sequence));
    broker_output_free(&queue);
    return 0;
}

int main(int argc, char **argv) {
    if (argc != 2 || signal(SIGPIPE, SIG_IGN) == SIG_ERR) return 126;
    if (!strcmp(argv[1], "binary")) return binary();
    if (!strcmp(argv[1], "budget")) return budget_and_ack();
    if (!strcmp(argv[1], "replay")) return replay_partial_ack();
    if (!strcmp(argv[1], "pressure")) return pressure();
    if (!strcmp(argv[1], "failure")) return failure();
    if (!strcmp(argv[1], "boundaries")) return boundaries();
    return 126;
}

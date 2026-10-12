/* Test-only native input reducer harness. It dispatches no command. */
#define main supervisor_cli_main
#include "../supervisor.c"
#undef main

int main(int argc, char **argv) {
    if (argc != 2 && argc != 3) return 126;
    struct broker_input_state state;
    if (!broker_input_initialize(&state, argv[1])) return 126;
    if (argc == 3) {
        if (strcmp(argv[2], "near-index-exhaustion")) return 126;
        /* A synthetic boundary fixture, not an assertion that these billions
         * of inputs were dispatched. It is never a production configuration. */
        state.epoch = 1;
        state.sequence = UINT32_MAX - 1;
        int count = snprintf((char *)state.previous, sizeof(state.previous),
            "OGB1\trequest\t%s\t1\t%u\t22222222-2222-4222-8222-222222222222\t-\tfence\t0\t0\tbase64\t\n",
            argv[1], state.sequence);
        if (count <= 0 || (size_t)count >= sizeof(state.previous)) return 126;
        state.previous_size = (size_t)count;
    }
    char *line = NULL;
    size_t capacity = 0;
    ssize_t length;
    while ((length = getline(&line, &capacity, stdin)) >= 0) {
        struct broker_input_state previous = state;
        struct broker_request request;
        enum broker_input_result result = broker_input_accept(&state, (unsigned char *)line,
                                                               (size_t)length, &request);
        if (result != BROKER_INPUT_NEW && memcmp(&previous, &state, sizeof(state))) return 124;
        const char *names[] = {"invalid", "rejected", "new", "replay"};
        printf("%s\t%" PRIu64 "\t%u\n", names[result], state.epoch, state.sequence);
    }
    free(line);
    return ferror(stdin) || fflush(stdout) ? 126 : 0;
}

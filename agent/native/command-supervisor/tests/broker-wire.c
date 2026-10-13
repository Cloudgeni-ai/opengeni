/* Test-only framing round trip over the exact native parser; no dispatch. */
#define main supervisor_cli_main
#include "../supervisor.c"
#undef main

int main(int argc, char **argv) {
    if (argc != 2) return 126;
    unsigned char bytes[BROKER_FRAME_MAX_BYTES + 1];
    size_t size = fread(bytes, 1, sizeof(bytes), stdin);
    if (ferror(stdin)) return 126;
    struct broker_request request;
    if (!broker_request_decode(bytes, size, argv[1], &request)) return 125;
    char encoded[((BROKER_CHUNK_BYTES + 2) / 3) * 4 + 1];
    (void)broker_base64(request.payload, request.size, encoded);
    if (printf("OGB1\trequest\t%s\t%" PRIu64 "\t%" PRIu64 "\t%s\t%s\t%s\t%" PRIu64 "\t%zu\tbase64\t%s\n",
        request.broker_id, request.epoch, request.sequence, request.request_id,
        request.broker_level ? "-" : request.command_id, broker_request_names[request.kind],
        request.offset, request.size, encoded) < 0 || fflush(stdout)) return 126;
    return 0;
}

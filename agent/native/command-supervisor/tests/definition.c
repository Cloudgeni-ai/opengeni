/* A test-only decoder/round-trip harness over actual production parser bytes.
 * It never executes the parsed command or enables a production CLI mode. */
#define main supervisor_cli_main
#include "../supervisor.c"
#undef main

static void output_u32(uint32_t value) {
    unsigned char bytes[] = {(unsigned char)(value >> 24), (unsigned char)(value >> 16),
                             (unsigned char)(value >> 8), (unsigned char)value};
    if (fwrite(bytes, 1, sizeof(bytes), stdout) != sizeof(bytes)) exit(126);
}

static void output_text(const char *text, size_t size) {
    output_u32((uint32_t)size);
    if (fwrite(text, 1, size, stdout) != size) exit(126);
}

int main(void) {
    unsigned char *input = malloc(BROKER_DEFINITION_MAX_BYTES + 1);
    if (!input) return 126;
    size_t size = fread(input, 1, BROKER_DEFINITION_MAX_BYTES + 1, stdin);
    if (ferror(stdin)) { free(input); return 126; }
    struct broker_definition definition;
    bool valid = broker_definition_decode(input, size, &definition);
    free(input);
    if (!valid) {
        /* Rejection must leave a zeroed, safely repeat-freeable result. */
        bool cleared = !definition.cwd && !definition.argv && !definition.env &&
            !definition.argc && !definition.envc && !definition.rows && !definition.columns && !definition.pty;
        broker_definition_free(&definition);
        return cleared ? 125 : 124;
    }
    unsigned char header[12] = {'O','G','C','D','1',0,definition.pty ? 1 : 0,0,
        (unsigned char)(definition.rows >> 8), (unsigned char)definition.rows,
        (unsigned char)(definition.columns >> 8), (unsigned char)definition.columns};
    if (fwrite(header, 1, sizeof(header), stdout) != sizeof(header)) return 126;
    output_u32((uint32_t)definition.argc);
    output_u32((uint32_t)definition.envc);
    output_text(definition.cwd, strlen(definition.cwd));
    for (size_t i = 0; i < definition.argc; i++)
        output_text(definition.argv[i], strlen(definition.argv[i]));
    for (size_t i = 0; i < definition.envc; i++) {
        char *separator = strchr(definition.env[i], '=');
        if (!separator) return 126;
        output_text(definition.env[i], (size_t)(separator - definition.env[i]));
        output_text(separator + 1, strlen(separator + 1));
    }
    broker_definition_free(&definition);
    broker_definition_free(&definition);
    return fflush(stdout) ? 126 : 0;
}

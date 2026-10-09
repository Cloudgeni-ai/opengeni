/* Bash 5.2 loadable builtin. No interposition, replacement shell, or prompt hook.
 * The Readline pre-input callback runs after terminal preparation and redisplay.
 * See README.md for the deliberately limited contract and ABI validation. */
#include "config.h"
#include "builtins.h"
#include "shell.h"
#include "variables.h"
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/random.h>
#include <unistd.h>

extern int (*rl_pre_input_hook)(void);
extern int parse_and_execute_level;
extern int subshell_environment;

static pid_t owner;
static int installed;
static int (*previous_hook)(void);
static char identity[33];

static int emit(const char *event) {
  char frame[100];
  int length = snprintf(frame, sizeof(frame), "\033]777;opengeni-input;%s;%s\007", event, identity);
  if (length < 0 || (size_t)length >= sizeof(frame)) return 0;
  size_t offset = 0;
  while (offset < (size_t)length) {
    ssize_t count = write(STDERR_FILENO, frame + offset, (size_t)length - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return 0;
    offset += (size_t)count;
  }
  return 1;
}

static int pre_input(void) {
  int result = previous_hook ? previous_hook() : 0;
  if (installed && owner == getpid() && interactive_shell &&
      parse_and_execute_level == 0 && subshell_environment == 0) {
    /* fflush first: the signal must follow any buffered prompt output. The
     * one-shot callback never retries input or infers readiness from stdout. */
    fflush(stderr);
    if (emit("ready")) {
      installed = 0;
      if (rl_pre_input_hook == pre_input) rl_pre_input_hook = previous_hook;
    }
  }
  return result;
}

static int terminal_ready(WORD_LIST *list) {
  const char *version = get_string_value("BASH_VERSION");
  if (!version || strncmp(version, "5.2.", 4) != 0) return EXECUTION_FAILURE;
  if (list && !list->next && strcmp(list->word->word, "--probe") == 0)
    return EXECUTION_SUCCESS;
  if (list || installed || owner || !interactive_shell || !login_shell ||
      !isatty(STDIN_FILENO) || !isatty(STDERR_FILENO)) return EXECUTION_FAILURE;
  unsigned char random[16];
  size_t offset = 0;
  while (offset < sizeof(random)) {
    ssize_t count = getrandom(random + offset, sizeof(random) - offset, 0);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return EXECUTION_FAILURE;
    offset += (size_t)count;
  }
  for (size_t i = 0; i < sizeof(random); i++)
    (void)snprintf(identity + i * 2, 3, "%02x", (unsigned int)random[i]);
  owner = getpid();
  previous_hook = rl_pre_input_hook;
  if (!emit("hello")) return EXECUTION_FAILURE;
  installed = 1;
  rl_pre_input_hook = pre_input;
  return EXECUTION_SUCCESS;
}

/* Bash invokes this before dlclose. A profile may deliberately unload us; that
 * becomes unsupported/manual mode, never a dangling callback or false READY. */
void opengeni_terminal_ready_builtin_unload(char *name) {
  (void)name;
  if (rl_pre_input_hook == pre_input) rl_pre_input_hook = previous_hook;
  installed = 0;
}

static char *documentation[] = {
  "Register the one-shot OpenGeni Bash 5.2 Readline input-readiness callback.",
  "--probe checks the loaded Bash ABI contract without registering a callback.",
  NULL,
};

struct builtin opengeni_terminal_ready_struct = {
  "opengeni_terminal_ready", terminal_ready, BUILTIN_ENABLED, documentation,
  "opengeni_terminal_ready [--probe]", NULL,
};

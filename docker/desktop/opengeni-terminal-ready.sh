# Sourced by the system login profile, before the user's unchanged login files.
# Ordinary shells never load the addon. Remove bootstrap metadata before user
# profiles or tools run; the callback itself is bound to this Bash process.
if [ "${OPENGENI_TERMINAL_READY-}" = bash-readline-v1 ]; then
  unset OPENGENI_TERMINAL_READY
  if [ -n "${BASH_VERSION-}" ]; then
    if enable -f /usr/local/lib/opengeni/opengeni-terminal-ready.so opengeni_terminal_ready 2>/dev/null; then
      opengeni_terminal_ready || :
    fi
  fi
fi

#!/usr/bin/env bash
# Playwright downloads its own pinned browsers. Its Ubuntu dependencies do not
# require the runner's preinstalled Google Chrome APT feed, which can be briefly
# inconsistent during publication. Keep all remaining feeds and integrity checks.
set -euo pipefail
source_dir="$1"
shift
backup_dir="$(mktemp -d)"
declare -a saved=()
move_file() {
  if [[ -w "$(dirname "$1")" && -w "$(dirname "$2")" ]]; then
    mv -- "$1" "$2"
  else
    sudo mv -- "$1" "$2"
  fi
}
restore() {
  local file
  for file in "${saved[@]}"; do
    [[ -e "$backup_dir/$file" ]] || continue
    if [[ -e "$source_dir/$file" ]]; then
      echo "Refusing to overwrite changed APT source: $source_dir/$file" >&2
      return 1
    fi
    move_file "$backup_dir/$file" "$source_dir/$file" || return 1
  done
  rmdir "$backup_dir"
}
trap 'status=$?; restore || exit 1; exit "$status"' EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
for source in "$source_dir"/*.list "$source_dir"/*.sources; do
  [[ -f "$source" && ! -L "$source" ]] || continue
  active="$(sed '/^[[:space:]]*#/d' "$source")"
  google='https?://dl\.google\.com/linux/chrome(-stable)?/deb/?'
  if ! grep -Eq "$google([[:space:]]|$)" <<<"$active"; then continue; fi
  # Parse repository fields, including non-HTTP transports. Never hide a mixed file.
  if [[ "$source" == *.list ]]; then
    urls="$(sed -E '/^[[:space:]]*$/d; s|^[[:space:]]*deb(-src)?[[:space:]]+(\[[^]]*\][[:space:]]+)?([^[:space:]]+).*|\3|' <<<"$active")"
  else
    urls="$(awk '
      /^[[:space:]]*$/ { in_uris=0; next }
      /^[^[:space:]]/ {
        in_uris=(tolower($1)=="uris:")
        if (in_uris) for (i=2; i<=NF; i++) print $i
        next
      }
      in_uris { for (i=1; i<=NF; i++) print $i }
    ' <<<"$active")"
  fi
  if grep -Evq "^$google$" <<<"$urls"; then
    echo "Cannot isolate Google Chrome feed from mixed APT source: $source" >&2
    exit 1
  fi
  name="$(basename "$source")"
  saved+=("$name")
  move_file "$source" "$backup_dir/$name"
done
"$@"

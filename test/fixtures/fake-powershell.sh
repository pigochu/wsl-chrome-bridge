#!/usr/bin/env bash
set -euo pipefail

capture_file="${WSL_CHROME_BRIDGE_CAPTURE_FILE:-}"
if [[ -n "${capture_file}" ]]; then
  {
    i=0
    for arg in "$@"; do
      printf 'arg[%s]=%s\n' "$i" "$arg"
      i=$((i + 1))
    done
  } > "${capture_file}"
fi

exit "${WSL_CHROME_BRIDGE_FAKE_PS_EXIT_CODE:-0}"

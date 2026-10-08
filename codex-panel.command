#!/bin/bash
# Start Codex on the same service used by the workbench. No shared config edits.
set -e
if ! command -v codex >/dev/null 2>&1; then
  export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
fi
panel_codex_home="${CODEX_HOME:-$HOME/.codex}"
if [ "${1:-}" = "--home" ]; then
  if [ -z "${2:-}" ]; then echo "用法：$0 --home /绝对路径 [Codex 参数]" >&2; exit 2; fi
  panel_codex_home="$2"
  shift 2
fi
case "$panel_codex_home" in /*) ;; *) echo "CODEX_HOME 必须为绝对路径" >&2; exit 2;; esac
for panel_arg in "$@"; do
  case "$panel_arg" in --no-daemon|--remote|--remote=*) echo "此启动器使用共享服务，请勿指定 --no-daemon 或 --remote" >&2; exit 2;; esac
done
# start is idempotent: it does not restart or upgrade an existing daemon.
CODEX_HOME="$panel_codex_home" codex app-server daemon start
exec env CODEX_HOME="$panel_codex_home" codex --remote "unix://$panel_codex_home/app-server-control/app-server-control.sock" "$@"

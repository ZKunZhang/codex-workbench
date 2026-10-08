#!/bin/bash
set -e
cd "$(dirname "$0")"

# Finder starts without an interactive shell, so load an existing nvm installation
# only when Node is absent. This does not change the user's default Node version.
if ! command -v node >/dev/null 2>&1; then
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    . "$HOME/.nvm/nvm.sh"
  fi
fi
if ! command -v node >/dev/null 2>&1; then
  echo "需要 Node.js 22.12 或更高版本。安装后重新打开此文件。"
  read -r -p "按回车退出…"
  exit 1
fi
if ! command -v pnpm >/dev/null 2>&1; then
  echo "需要 pnpm 12.10.1。请先通过 Corepack 或现有包管理环境准备 pnpm。"
  read -r -p "按回车退出…"
  exit 1
fi
if [ ! -f node_modules/.modules.yaml ]; then
  pnpm install --frozen-lockfile
fi
pnpm build
echo "浏览器打开 http://127.0.0.1:${PORT:-4310}"
exec pnpm start

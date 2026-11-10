#!/usr/bin/env bash
# Пуска локалния уеб app на Supacode Remote: npm install при нужда, после сървъра на
# 127.0.0.1 и браузъра.  PORT=8791 web/run.sh — друг порт;  --no-open — без браузър.
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -d node_modules ] || [ package.json -nt node_modules ]; then
  npm install --no-audit --no-fund
  touch node_modules
fi
exec node server.mjs "$@"

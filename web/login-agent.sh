#!/usr/bin/env bash
# Пуска уеб app-а при всеки login на Mac-а, във фон, като LaunchAgent на launchd.
#   web/login-agent.sh install    — записва agent-а и го пуска веднага (повторно — заменя го)
#   web/login-agent.sh uninstall  — спира го и го маха от login
# Node се взима от PATH или от NODE=/път/до/node. Пътят се записва в agent-а, защото launchd
# не чете профила на shell-а и не вижда node от nvm.
set -euo pipefail

LABEL=local.supacode-remote.web
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/supacode-remote-web.log"
WEB_DIR="$(cd "$(dirname "$0")" && pwd)"
DOMAIN="gui/$(id -u)"

die() { echo "Грешка: $*" >&2; exit 1; }

# Пътищата отиват в XML; & и < биха го счупили.
xml() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<<"$1"; }

loaded() { launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; }

# bootout връща преди launchd да е махнал agent-а; bootstrap веднага след него пада с грешка 5.
unload() {
  loaded || return 0
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  for _ in $(seq 50); do
    loaded || return 0
    sleep 0.1
  done
  die "launchd не спря $LABEL"
}

find_node() {
  local node="${NODE:-$(command -v node || true)}"
  [ -n "$node" ] || die "няма node в PATH; пусни с NODE=/път/до/node"
  [ -x "$node" ] || die "$node не е изпълним файл"
  local major
  major="$("$node" -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 22 ] || die "$node е версия $major, уеб app-ът иска Node 22 или по-нов"
  # run.sh пуска npm install, а npm трябва да е до същия node.
  [ -x "$(dirname "$node")/npm" ] || die "няма npm до $node"
  echo "$node"
}

write_plist() {
  local node_dir="$1"
  mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
  local tmp="$PLIST.tmp"
  cat >"$tmp" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$(xml "$WEB_DIR/run.sh")</string>
    <string>--no-open</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(xml "$node_dir"):/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$(xml "$LOG")</string>
  <key>StandardErrorPath</key><string>$(xml "$LOG")</string>
</dict>
</plist>
EOF
  plutil -lint -s "$tmp" || { rm -f "$tmp"; die "plist-ът не е валиден"; }
  mv "$tmp" "$PLIST"
}

install() {
  local node
  node="$(find_node)"
  unload
  write_plist "$(dirname "$node")"
  launchctl bootstrap "$DOMAIN" "$PLIST"
  echo "Готово: $LABEL тръгва при login. Node: $node ($("$node" -v))"
  echo "Страницата: http://localhost:8790  Логът: $LOG"
}

uninstall() {
  unload
  rm -f "$PLIST"
  echo "Готово: $LABEL е спрян и махнат от login. Логът остава: $LOG"
}

[ "$(uname)" = Darwin ] || die "LaunchAgent има само на macOS"
case "${1:-}" in
  install) install ;;
  uninstall) uninstall ;;
  *) echo "Употреба: $0 install|uninstall" >&2; exit 2 ;;
esac

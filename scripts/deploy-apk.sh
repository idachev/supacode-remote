#!/bin/bash
# Копира последния debug APK в папка, която стига до телефона (напр. папка в Dropbox).
# Пуска се от корена на repo-то след ./build-project.sh.
#
# Папката е APK_DIR — от средата или от scripts/deploy-apk.local (локален файл извън git,
# защото пътят е личен), например:
#   APK_DIR="$HOME/Dropbox/mobile/<user>/supacode-remote"
#
# В папката остава точно едно APK, за да не се инсталира по грешка старо. Предишните
# отиват в old/ преди копирането, така че и при грешка по средата новото не е смесено
# със старите. Накрая папката се отваря във Finder, защото иначе Dropbox понякога не
# качва файла веднага.
set -euo pipefail

SRC="app/build/outputs/apk/debug/app-debug.apk"
LOCAL_CONFIG="scripts/deploy-apk.local"

if [ -z "${APK_DIR:-}" ] && [ -f "$LOCAL_CONFIG" ]; then
  # shellcheck source=/dev/null
  source "$LOCAL_CONFIG"
fi
if [ -z "${APK_DIR:-}" ]; then
  echo "Няма APK_DIR. Задай го в средата или в $LOCAL_CONFIG, например:" >&2
  echo "  APK_DIR=\"\$HOME/Dropbox/mobile/<user>/supacode-remote\"" >&2
  exit 1
fi
DEST="$APK_DIR"

if [ ! -f "$SRC" ]; then
  echo "Няма $SRC — първо пусни ./build-project.sh" >&2
  exit 1
fi

NAME="supacode-remote-debug-$(date +%Y%m%d-%H%M).apk"

mkdir -p "$DEST/old"
find "$DEST" -maxdepth 1 -name '*.apk' -exec mv {} "$DEST/old/" \;
cp "$SRC" "$DEST/$NAME"

echo "APK: $DEST/$NAME"
open "$DEST"

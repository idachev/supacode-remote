#!/bin/bash
# Пълен билд: unit тестове + debug APK.
# Логът отива в ./tmp/claude-logs/ с дата и час в името.
set -o pipefail

export ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"

mkdir -p ./tmp/claude-logs
LOG="./tmp/claude-logs/build-project-$(date +%Y%m%d-%H%M%S).log"

echo "Логът е в: $LOG"
BUILD_TIME_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
# Преди първия commit HEAD няма. Тогава SHA-то е "none", а не грешка в билда.
GIT_SHORT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo none)"
./gradlew \
  -PsupacodeRemoteBuildTimeUtc="$BUILD_TIME_UTC" \
  -PsupacodeRemoteGitShortSha="$GIT_SHORT_SHA" \
  :app:testDebugUnitTest :app:assembleDebug "$@" > "$LOG" 2>&1
RC=$?

tail -n 40 "$LOG"
if [ $RC -eq 0 ]; then
  echo
  echo "APK: $(ls -1 app/build/outputs/apk/debug/*.apk 2>/dev/null)"
fi
echo "exit=$RC  log=$LOG"
exit $RC

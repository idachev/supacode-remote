// Кой код върти уеб app-ът (УА14): SHA на checkout-а и дали има промени, прочетени веднъж при
// пускане. LaunchAgent-ът пуска `web/run.sh` от основния checkout, затова без това не се вижда дали
// след commit-а сървърът е рестартиран.
import { execFileSync } from 'node:child_process';

/** Изходът на `git` в `cwd` или `null`, ако git го няма или папката не е repo. */
function gitOutput(exec, cwd, args) {
  try {
    return String(exec('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    return null;
  }
}

/** `{sha, dirty, startedAt}`; без git — `sha: null`, сървърът пак тръгва. */
export function readBuildInfo({ cwd, exec = execFileSync, now = new Date() }) {
  const sha = gitOutput(exec, cwd, ['rev-parse', '--short', 'HEAD'])?.trim() || null;
  // Само проследените файлове: `tmp/` и логовете не са промяна в кода.
  const status = sha ? gitOutput(exec, cwd, ['status', '--porcelain', '--untracked-files=no']) : null;
  return { sha, dirty: Boolean(status?.trim()), startedAt: now.toISOString() };
}

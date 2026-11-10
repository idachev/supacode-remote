// Настройките на уеб app-а извън repo-то: `~/.config/supacode-remote-web/config.json`.
// Ключът за връзка е тайна, затова файлът е 0600, а папката 0700.

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function defaultConfigDir() {
  return process.env.SUPACODE_REMOTE_WEB_CONFIG_DIR || join(homedir(), '.config', 'supacode-remote-web');
}

export class ConfigStore {
  constructor(dir = defaultConfigDir()) {
    this.dir = dir;
    this.file = join(dir, 'config.json');
  }

  /** `{connectionKey, selectedHostId}`; празно, ако файлът липсва или е счупен. */
  async load() {
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'));
      return {
        connectionKey: typeof data.connectionKey === 'string' ? data.connectionKey : null,
        // Място за multi-host избора (ОП20): още не се пише от UI-а.
        selectedHostId: typeof data.selectedHostId === 'string' ? data.selectedHostId : null,
      };
    } catch {
      return { connectionKey: null, selectedHostId: null };
    }
  }

  /** Записва наведнъж (временен файл + rename), за да не остане половин файл. */
  async save(config) {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.file);
  }
}

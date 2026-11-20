// Настройките на mock-а от средата (описани в горния коментар на mock-host.mjs). На едно място,
// защото няколко модула ползват един и същ ключ и размер.

export const PORT = Number(process.env.PORT ?? 8787);
export const KEY = process.env.KEY ?? 'test-key';
export const LAN_PORT = Number(process.env.LAN_PORT ?? 8788);
export const LAN_ADDRS = (process.env.LAN_ADDRS ?? '10.0.2.2').split(',');
/** Дали LAN endpoint-ът тръгва при пускане; после го сменят `mock-lan-off` / `mock-lan-on`. */
export const LAN_AT_START = process.env.LAN !== '0';
export const COLS = 120;
export const ROWS = 40;
/** Най-много толкова закачени таба на връзка (`attach` с `keep`); 16 като на Mac-а. */
export const ATTACH_LIMIT = Number(process.env.MOCK_ATTACH_LIMIT ?? 16);
/** Колко дълго задържан размер остава без собственик след паднала връзка. */
export const HOLD_GRACE_MS = Number(process.env.MOCK_HOLD_GRACE_MS ?? 30_000);
export const WITH_SECTIONS = process.env.MOCK_NO_SECTIONS !== '1';
export const OLD_RELAY = process.env.MOCK_OLD_RELAY === '1';
export const SINGLE_HOST = process.env.MOCK_SINGLE_HOST === '1';
export const LEGACY_HOST = process.env.MOCK_LEGACY === '1';

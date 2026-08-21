const REFRESH_INTERVAL_STORAGE_KEY = 'ARCHON_REFRESH_INTERVAL_SECONDS';
const DEFAULT_REFRESH_INTERVAL_SECONDS = 30;

// How often a screen that polls should poll, in seconds; 0 means manual only.
// Both wallets keep this in localStorage under the same key, so this needs no
// injection -- unlike the state each of them persists per host.
export function loadRefreshIntervalSeconds(): number {
    const saved = localStorage.getItem(REFRESH_INTERVAL_STORAGE_KEY);
    const parsed = Number(saved);

    if (!saved || !Number.isFinite(parsed) || parsed < 0) {
        return DEFAULT_REFRESH_INTERVAL_SECONDS;
    }

    return Math.floor(parsed);
}

import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// jsdom installs its own realm's typed arrays over the globals, so a Node
// Buffer -- which extends Node's Uint8Array -- fails `instanceof Uint8Array`.
// bip39 hands such a Buffer to the HD key derivation, and @noble/hashes rejects
// it with "Uint8Array expected", surfacing as "Invalid parameter: mnemonic"
// because newWallet catches and relabels it.
Object.defineProperty(globalThis, 'Uint8Array', {
    value: Object.getPrototypeOf(Buffer.prototype).constructor,
    writable: true,
    configurable: true,
});

// MUI's useMediaQuery calls this during the first render.
Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
    }),
});

// No gatekeeper is running; failing fast keeps the run deterministic and stops
// a late rejection landing after teardown.
vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no gatekeeper in tests')));

// The extension's host API. This is the capability seam the shared components
// are built around -- chrome.storage.sync is asynchronous and is why
// loadRefreshInterval is injected rather than read from localStorage.
const store = new Map<string, unknown>();

vi.stubGlobal('chrome', {
    runtime: {
        sendMessage: vi.fn().mockResolvedValue(undefined),
        onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
        lastError: undefined,
        id: 'test-extension-id',
    },
    storage: {
        sync: {
            get: vi.fn(async (keys: string | string[]) => {
                const names = Array.isArray(keys) ? keys : [keys];
                return Object.fromEntries(
                    names.filter(name => store.has(name)).map(name => [name, store.get(name)])
                );
            }),
            set: vi.fn(async (items: Record<string, unknown>) => {
                Object.entries(items).forEach(([key, value]) => store.set(key, value));
            }),
            remove: vi.fn(async () => {}),
        },
        local: {
            get: vi.fn(async () => ({})),
            set: vi.fn(async () => {}),
            remove: vi.fn(async () => {}),
        },
    },
    tabs: {
        create: vi.fn(async () => ({})),
        query: vi.fn(async () => []),
        sendMessage: vi.fn(async () => undefined),
    },
    windows: { create: vi.fn(async () => ({})) },
});

afterEach(() => {
    cleanup();
    store.clear();
    localStorage.clear();
    sessionStorage.clear();
});

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

// The extension's host API. Every chrome.* member the extension source touches
// is stubbed, not a guess at which ones mount reaches: an effect calling a
// missing one throws in a passive effect AFTER the assertions pass, so vitest
// reports it as an unhandled error and exits non-zero while every test shows
// green. chrome-api-coverage.test.ts keeps this in step with the source.
const syncStore = new Map<string, unknown>();
const localStore = new Map<string, unknown>();

function area(store: Map<string, unknown>) {
    return {
        get: vi.fn(async (keys?: string | string[] | null) => {
            if (keys === undefined || keys === null) {
                return Object.fromEntries(store);
            }
            const names = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(
                names.filter(name => store.has(name)).map(name => [name, store.get(name)])
            );
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
            Object.entries(items).forEach(([key, value]) => store.set(key, value));
        }),
        remove: vi.fn(async (keys: string | string[]) => {
            (Array.isArray(keys) ? keys : [keys]).forEach(key => store.delete(key));
        }),
    };
}

function listenable() {
    return { addListener: vi.fn(), removeListener: vi.fn(), hasListener: vi.fn(() => false) };
}

vi.stubGlobal('chrome', {
    runtime: {
        id: 'test-extension-id',
        lastError: undefined,
        getURL: vi.fn((path: string) => `chrome-extension://test-extension-id/${path}`),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        onMessage: listenable(),
        onInstalled: listenable(),
        onStartup: listenable(),
        OnInstalledReason: { INSTALL: 'install' },
    },
    storage: {
        sync: area(syncStore),
        local: area(localStore),
        session: area(new Map()),
        onChanged: listenable(),
    },
    tabs: {
        create: vi.fn(async () => ({})),
        update: vi.fn(async () => ({})),
        query: vi.fn(async () => []),
        sendMessage: vi.fn(async () => undefined),
        onUpdated: listenable(),
    },
    windows: { create: vi.fn(async () => ({})) },
    action: { openPopup: vi.fn(async () => undefined) },
});

afterEach(() => {
    cleanup();
    syncStore.clear();
    localStore.clear();
    localStorage.clear();
    sessionStorage.clear();
});

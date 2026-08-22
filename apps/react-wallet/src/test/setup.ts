import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// Testing Library only auto-cleans when jest-style globals are injected, which
// this config deliberately does not do. Without this each test's tree stays in
// the document and the next one's queries match two of everything.
afterEach(() => {
    cleanup();
    // A completed setup writes a wallet, and these tests assume they start
    // without one.
    localStorage.clear();
    sessionStorage.clear();
});

// jsdom installs its own realm's typed arrays over the globals, so a Node
// Buffer -- which extends Node's Uint8Array -- fails `instanceof Uint8Array`.
// bip39 hands such a Buffer to the HD key derivation, and @noble/hashes rejects
// it with "Uint8Array expected", which surfaces as "Invalid parameter: mnemonic"
// because newWallet catches and relabels it. Restoring Node's constructors makes
// the check mean what it says. Must run before anything else imports.
Object.defineProperty(globalThis, 'Uint8Array', {
    value: Object.getPrototypeOf(Buffer.prototype).constructor,
    writable: true,
    configurable: true,
});

// Browser APIs jsdom does not implement, which the provider tree touches on
// mount. Each is here because something throws without it, not pre-emptively.

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

// Capacitor's native bridges have no implementation under jsdom. Mocking the
// modules keeps the test about the provider tree rather than about Capacitor:
// what matters is that the tree mounts, not that a camera answers.
vi.mock('@capacitor/core', () => ({
    Capacitor: {
        isNativePlatform: () => false,
        getPlatform: () => 'web',
        isPluginAvailable: () => false,
    },
}));

vi.mock('@capacitor/app', () => ({
    App: {
        addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }),
        removeAllListeners: vi.fn().mockResolvedValue(undefined),
        getLaunchUrl: vi.fn().mockResolvedValue(null),
    },
}));

// No gatekeeper is running, and WalletProvider's initialiseServices already
// catches the failure -- but an unstubbed fetch spends the test retrying a
// connection, and its rejection can land after teardown as an unhandled error.
// Failing immediately keeps the run deterministic and fast; the wallet itself
// is created locally and needs no node.
vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no gatekeeper in tests')));

vi.mock('@capacitor-mlkit/barcode-scanning', () => ({
    BarcodeScanner: {
        scan: vi.fn().mockResolvedValue({ barcodes: [] }),
        requestPermissions: vi.fn().mockResolvedValue({ camera: 'denied' }),
        isGoogleBarcodeScannerModuleAvailable: vi.fn().mockResolvedValue(false),
    },
}));

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { scanQrFrames } from '../utils/utils';

// The continuous scanner the wallet gives the shared UI on Android. The plugin
// is replaced by one whose camera the test drives: it hands the listener the
// codes it is told to "see".

type Listener = (event: { barcodes: { rawValue: string }[] }) => void;

const plugin = vi.hoisted(() => ({
    listener: undefined as Listener | undefined,
    removed: 0,
    requestPermissions: vi.fn(),
    startScan: vi.fn(),
    stopScan: vi.fn(),
}));

vi.mock('@capacitor-mlkit/barcode-scanning', () => ({
    BarcodeFormat: { QrCode: 'QR_CODE' },
    BarcodeScanner: {
        requestPermissions: plugin.requestPermissions,
        startScan: plugin.startScan,
        stopScan: plugin.stopScan,
        addListener: vi.fn(async (_event: string, listener: Listener) => {
            plugin.listener = listener;
            return { remove: async () => { plugin.removed += 1; plugin.listener = undefined; } };
        }),
    },
}));

const see = (...codes: string[]) => plugin.listener?.({ barcodes: codes.map(rawValue => ({ rawValue })) });
const scanning = () => document.body.classList.contains('barcode-scanner-active');
const overlay = () => document.querySelector('.barcode-scanner-modal');
// Lets the scan reach the point where the camera is open.
const opened = () => vi.waitFor(() => expect(plugin.startScan).toHaveBeenCalled());

beforeEach(() => {
    plugin.listener = undefined;
    plugin.removed = 0;
    plugin.requestPermissions.mockReset().mockResolvedValue({ camera: 'granted' });
    plugin.startScan.mockReset().mockResolvedValue(undefined);
    plugin.stopScan.mockReset().mockResolvedValue(undefined);
});

describe('scanQrFrames', () => {
    it('gives each code to accept until the text is complete, then closes the camera', async () => {
        const accept = vi.fn((scanned: string) => (scanned === 'last' ? 1 : 0.5));
        const scan = scanQrFrames(accept);
        await opened();
        expect(plugin.startScan).toHaveBeenCalledWith({ formats: ['QR_CODE'] });
        expect(scanning()).toBe(true);
        expect(overlay()).not.toBeNull();

        see('first');
        see('second', 'last', 'after');

        await expect(scan).resolves.toBe(true);
        expect(accept.mock.calls.map(([scanned]) => scanned)).toEqual(['first', 'second', 'last']);
        expect(plugin.stopScan).toHaveBeenCalledTimes(1);
        expect(plugin.removed).toBe(1);
        expect(scanning()).toBe(false);
        expect(overlay()).toBeNull();
    });

    it('shows how far an animated code has got', async () => {
        const scan = scanQrFrames(scanned => Number(scanned));
        await opened();
        expect(overlay()!.textContent).toContain('Point the camera at the QR code');

        see('0.42');
        expect(overlay()!.querySelector('[role="status"]')!.textContent).toContain('42%');

        see('1');
        await scan;
    });

    it('resolves false and closes the camera when the user cancels', async () => {
        const accept = vi.fn(() => 0.5);
        const scan = scanQrFrames(accept);
        await opened();
        see('part');

        (overlay()!.querySelector('button') as HTMLButtonElement).click();

        await expect(scan).resolves.toBe(false);
        expect(plugin.stopScan).toHaveBeenCalledTimes(1);
        expect(plugin.removed).toBe(1);
        expect(scanning()).toBe(false);
        expect(overlay()).toBeNull();
    });

    it('does not open the camera without permission', async () => {
        plugin.requestPermissions.mockResolvedValue({ camera: 'denied' });

        await expect(scanQrFrames(() => 1)).resolves.toBe(false);
        expect(plugin.startScan).not.toHaveBeenCalled();
        expect(overlay()).toBeNull();
    });

    it('resolves false and leaves the page visible when the camera cannot start', async () => {
        plugin.startScan.mockRejectedValue(new Error('no camera'));

        await expect(scanQrFrames(() => 1)).resolves.toBe(false);
        expect(plugin.removed).toBe(1);
        expect(scanning()).toBe(false);
        expect(overlay()).toBeNull();
    });
});

import {Capacitor} from "@capacitor/core";
import {BarcodeFormat, BarcodeScanner} from "@capacitor-mlkit/barcode-scanning";

export function extractDid(input: string): string | null {
    if (!input) {
        return null;
    }

    const didRegex = /did:[a-z0-9]+:[^\s&#?]+/i;

    const direct = input.match(didRegex);
    if (direct) {
        return direct[0];
    }

    try {
        const url = new URL(input);

        if (url.protocol === 'archon:') {
            const host = (url.host || '').toLowerCase();

            if (host === 'auth') {
                const challenge = url.searchParams.get('challenge');
                if (challenge?.startsWith('did:')) {
                    return challenge;
                }
            }

            if (host === 'accept') {
                const credential = url.searchParams.get('credential');
                if (credential?.startsWith('did:')) {
                    return credential;
                }
            }
        }

        if (url.protocol === 'https:' || url.protocol === 'http:') {
            const parts = url.pathname.split('/').filter(Boolean);
            if (parts.length >= 2 && parts[0].toLowerCase() === 'attest') {
                const cand = decodeURIComponent(parts[1]);
                if (cand.startsWith('did:')) {
                    return cand;
                }
            }

            const challenge = url.searchParams.get('challenge');
            if (challenge?.startsWith('did:')) {
                return challenge;
            }

            const credential = url.searchParams.get('credential');
            if (credential?.startsWith('did:')) {
                return credential;
            }
        }

        const fallback = input.match(didRegex)?.[0];
        if (fallback) {
            return fallback;
        }
    } catch {}

    return null;
}

export function extractAlias(input: string): { alias: string; did: string } | null {
    if (!input) {
        return null;
    }

    try {
        const url = new URL(input);

        if (url.protocol === 'archon:' && (url.host || '').toLowerCase() === 'accept') {
            const alias = url.searchParams.get('alias');
            const did = url.searchParams.get('did');
            if (alias && did?.startsWith('did:')) {
                return { alias, did };
            }
        }
    } catch {}

    return null;
}

async function ensureGoogleModuleReady(timeoutMs = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable()) {
            return true;
        }
        await new Promise(r => setTimeout(r, 400));
    }
    return false;
}

export async function scanQrCode() {
    try {
        const perm = await BarcodeScanner.requestPermissions();
        if (perm.camera !== 'granted') {
            return null;
        }

        const ready = await ensureGoogleModuleReady();
        if (!ready) {
            return null;
        }

        const { barcodes } = await BarcodeScanner.scan();

        let did: string | null = null;
        for (const b of barcodes) {
            const candidate = extractDid(b.rawValue);
            if (candidate) {
                did = candidate;
                break;
            }
        }

        if (!did) {
            return null;
        }

        return did;
    } catch {}
    return null;
}

// "Raw" here means the whole payload rather than the extracted DID -- but only
// for codes that carry a DID somewhere. Callers scanning something with no DID
// in it (an out-of-band invitation hides its DID inside a base64url payload)
// want scanQrText instead.
export async function scanQrCodeRaw(): Promise<string | null> {
    try {
        const perm = await BarcodeScanner.requestPermissions();
        if (perm.camera !== 'granted') {
            return null;
        }

        const ready = await ensureGoogleModuleReady();
        if (!ready) {
            return null;
        }

        const { barcodes } = await BarcodeScanner.scan();

        for (const b of barcodes) {
            if (extractDid(b.rawValue)) {
                return b.rawValue;
            }
        }
    } catch {}
    return null;
}

// The scanned text, with no interpretation at all. Out-of-band invitations are
// `https://didcomm.org?_oob=<base64url>`: the DID is inside the payload and the
// base64url alphabet has no `:`, so every DID-shaped filter rejects them.
// Validation belongs to the caller, which knows what it asked the user to scan.
export async function scanQrText(): Promise<string | null> {
    try {
        const perm = await BarcodeScanner.requestPermissions();
        if (perm.camera !== 'granted') {
            return null;
        }

        const ready = await ensureGoogleModuleReady();
        if (!ready) {
            return null;
        }

        const { barcodes } = await BarcodeScanner.scan();
        return barcodes[0]?.rawValue ?? null;
    } catch {}
    return null;
}

const SCANNING_CLASS = 'barcode-scanner-active';

// While the camera is open the plugin draws its preview behind the web view,
// so the page has to be hidden for it to show. Only this overlay stays visible.
function scannerOverlay(onCancel: () => void) {
    if (!document.getElementById('barcode-scanner-style')) {
        const style = document.createElement('style');
        style.id = 'barcode-scanner-style';
        style.textContent = `
            html.${SCANNING_CLASS}, body.${SCANNING_CLASS} { background: transparent !important; }
            body.${SCANNING_CLASS} { visibility: hidden; }
            .barcode-scanner-modal {
                visibility: visible; position: fixed; inset: 0; z-index: 2147483647;
                display: flex; flex-direction: column; justify-content: space-between; align-items: center;
                padding: calc(24px + env(safe-area-inset-top)) 24px calc(24px + env(safe-area-inset-bottom));
                color: #fff; font-family: sans-serif; text-align: center;
            }
            .barcode-scanner-modal p { margin: 0; padding: 8px 12px; border-radius: 8px; background: rgba(0, 0, 0, 0.6); }
            .barcode-scanner-modal button {
                padding: 12px 32px; border: 0; border-radius: 24px; font-size: 16px;
                color: #000; background: #fff;
            }`;
        document.head.appendChild(style);
    }
    const modal = document.createElement('div');
    modal.className = 'barcode-scanner-modal';
    const status = document.createElement('p');
    status.setAttribute('role', 'status');
    status.textContent = 'Point the camera at the QR code';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', onCancel);
    modal.append(status, cancel);
    document.body.appendChild(modal);
    document.documentElement.classList.add(SCANNING_CLASS);
    document.body.classList.add(SCANNING_CLASS);
    return {
        progress(fraction: number) {
            status.textContent = `Reading an animated code: ${Math.floor(fraction * 100)}%. Keep the camera on it.`;
        },
        remove() {
            document.documentElement.classList.remove(SCANNING_CLASS);
            document.body.classList.remove(SCANNING_CLASS);
            modal.remove();
        },
    };
}

// Keeps the camera open and gives every QR code it reads to `accept` until
// that reports the text complete, or the user cancels. An animated code, such
// as a long Cashu token, arrives over many reads; the one-shot scanner above
// returns after the first. Resolves whether the text was completed.
export async function scanQrFrames(accept: (scanned: string) => number): Promise<boolean> {
    try {
        const perm = await BarcodeScanner.requestPermissions();
        if (perm.camera !== 'granted') {
            return false;
        }
    } catch {
        return false;
    }

    let finish!: (completed: boolean) => void;
    const finished = new Promise<boolean>(resolve => { finish = resolve; });
    const overlay = scannerOverlay(() => finish(false));
    // Reads keep arriving while the scan is being stopped.
    let done = false;
    const listening = BarcodeScanner.addListener('barcodesScanned', ({ barcodes }) => {
        for (const barcode of barcodes) {
            if (done) {
                return;
            }
            const fraction = accept(barcode.rawValue);
            if (fraction >= 1) {
                done = true;
                finish(true);
            } else if (fraction > 0) {
                overlay.progress(fraction);
            }
        }
    });
    try {
        await listening;
        await BarcodeScanner.startScan({ formats: [BarcodeFormat.QrCode] });
        return await finished;
    } catch {
        return false;
    } finally {
        done = true;
        await listening.then(listener => listener.remove()).catch(() => undefined);
        await BarcodeScanner.stopScan().catch(() => undefined);
        overlay.remove();
    }
}

// The continuous scanner, where this app has one. It also runs in a browser,
// where the plugin would need a video element to draw into, which nothing here
// gives it; a view offers no scan without this.
export function nativeScanQrFrames(): typeof scanQrFrames | undefined {
    return Capacitor.isNativePlatform() ? scanQrFrames : undefined;
}

export async function scanAliasQrCode(): Promise<{ alias: string; did: string } | null> {
    try {
        const perm = await BarcodeScanner.requestPermissions();
        if (perm.camera !== 'granted') {
            return null;
        }

        const ready = await ensureGoogleModuleReady();
        if (!ready) {
            return null;
        }

        const { barcodes } = await BarcodeScanner.scan();

        for (const b of barcodes) {
            const result = extractAlias(b.rawValue);
            if (result) {
                return result;
            }
        }
    } catch {}
    return null;
}


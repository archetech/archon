import {BarcodeScanner} from "@capacitor-mlkit/barcode-scanning";

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


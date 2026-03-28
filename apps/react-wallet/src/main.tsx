import ReactDOM from "react-dom/client";
import BrowserContent from "./BrowserContent";
import { ContextProviders } from "./contexts/ContextProviders";
import "./extension.css";
import "./utils/polyfills";
import { App } from '@capacitor/app';
import { queueDeepLink } from './utils/deepLinkQueue';
import { BarcodeScanner } from '@capacitor-mlkit/barcode-scanning';
import { Capacitor } from '@capacitor/core';

type PendingWalletAction =
    | { type: 'auth'; challenge: string; deepLinkUrl: string }
    | { type: 'credential'; credential: string; deepLinkUrl: string }
    | { type: 'alias'; alias: string; did: string; deepLinkUrl: string };

function getPendingWalletAction(): PendingWalletAction | null {
    const params = new URLSearchParams(window.location.search);
    const challenge = params.get('challenge');
    if (challenge?.startsWith('did:')) {
        return {
            type: 'auth',
            challenge,
            deepLinkUrl: `archon://auth?challenge=${encodeURIComponent(challenge)}`,
        };
    }

    const credential = params.get('credential');
    if (credential?.startsWith('did:')) {
        return {
            type: 'credential',
            credential,
            deepLinkUrl: `archon://accept?credential=${encodeURIComponent(credential)}`,
        };
    }

    const alias = params.get('alias');
    const did = params.get('did');
    if (alias && did?.startsWith('did:')) {
        return {
            type: 'alias',
            alias,
            did,
            deepLinkUrl: `archon://accept?alias=${encodeURIComponent(alias)}&did=${encodeURIComponent(did)}`,
        };
    }

    return null;
}

function queueAndDispatch(url: string) {
    queueDeepLink(url);
    window.dispatchEvent(new Event('archon:deepLinkQueued'));
}

function isMobileBrowser() {
    const ua = navigator.userAgent || '';
    return /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
}

function isNativeApp() {
    return Capacitor.getPlatform() !== 'web';
}

function makeRequestId() {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function waitForWindowMessage<T>(type: string, requestId: string, timeoutMs: number): Promise<T | null> {
    return new Promise((resolve) => {
        const timeout = window.setTimeout(() => {
            window.removeEventListener('message', onMessage);
            resolve(null);
        }, timeoutMs);

        function onMessage(event: MessageEvent) {
            if (event.source !== window) {
                return;
            }
            if (event.data?.type !== type || event.data?.requestId !== requestId) {
                return;
            }
            window.clearTimeout(timeout);
            window.removeEventListener('message', onMessage);
            resolve(event.data as T);
        }

        window.addEventListener('message', onMessage);
    });
}

async function tryExtensionHandoff(action: PendingWalletAction): Promise<boolean> {
    const probeRequestId = makeRequestId();
    const probePromise = waitForWindowMessage<{ available?: boolean }>(
        'archon-wallet-extension-probe-response',
        probeRequestId,
        300,
    );
    window.postMessage({ type: 'archon-wallet-extension-probe', requestId: probeRequestId }, '*');
    const probe = await probePromise;
    if (!probe?.available) {
        return false;
    }

    const openRequestId = makeRequestId();
    const responsePromise = waitForWindowMessage<{ ok?: boolean }>(
        'archon-wallet-extension-open-response',
        openRequestId,
        1000,
    );
    window.postMessage({
        type: 'archon-wallet-extension-open',
        requestId: openRequestId,
        action: action.type,
        challenge: action.type === 'auth' ? action.challenge : undefined,
        credential: action.type === 'credential' ? action.credential : undefined,
        alias: action.type === 'alias' ? action.alias : undefined,
        did: action.type === 'alias' ? action.did : undefined,
    }, '*');

    const response = await responsePromise;
    return !!response?.ok;
}

async function handleWalletUrl() {
    const action = getPendingWalletAction();
    if (!action) {
        return;
    }

    if (!isNativeApp() && !isMobileBrowser()) {
        const handledByExtension = await tryExtensionHandoff(action);
        if (handledByExtension) {
            return;
        }
    }

    if (!isNativeApp() && isMobileBrowser()) {
        const fallbackTimer = window.setTimeout(() => {
            if (document.visibilityState === 'visible') {
                queueAndDispatch(action.deepLinkUrl);
            }
        }, 1200);

        const onVisibility = () => {
            if (document.visibilityState === 'hidden') {
                window.clearTimeout(fallbackTimer);
                document.removeEventListener('visibilitychange', onVisibility);
            }
        };

        document.addEventListener('visibilitychange', onVisibility);
        window.location.href = action.deepLinkUrl;
        return;
    }

    queueAndDispatch(action.deepLinkUrl);
}

App.addListener('appUrlOpen', ({ url }) => {
    queueAndDispatch(url);
});

(async () => {
    const launch = await App.getLaunchUrl();
    if (launch?.url) {
        queueAndDispatch(launch.url);
    }
})();

handleWalletUrl();

(async () => {
    try {
        const has = await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable();
        if (!has) {
            await BarcodeScanner.installGoogleBarcodeScannerModule();
        }
    } catch {}
})();

const BrowserUI = () => {
    return (
        <ContextProviders>
            <BrowserContent />
        </ContextProviders>
    );
};

const root = ReactDOM.createRoot(document.getElementById("root")!);
root.render(<BrowserUI />);

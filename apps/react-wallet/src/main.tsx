import React, { useEffect, useState } from "react";
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

type WalletUrlResult =
    | { status: 'none' }
    | { status: 'extension-handoff'; action: PendingWalletAction }
    | { status: 'fallback'; action: PendingWalletAction };

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

const handoffTargetOrigin = window.location.origin;

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
    window.postMessage({ type: 'archon-wallet-extension-probe', requestId: probeRequestId }, handoffTargetOrigin);
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
    }, handoffTargetOrigin);

    const response = await responsePromise;
    return !!response?.ok;
}

async function handleWalletUrl(): Promise<WalletUrlResult> {
    const action = getPendingWalletAction();
    if (!action) {
        return { status: 'none' };
    }

    if (!isNativeApp() && !isMobileBrowser()) {
        const handledByExtension = await tryExtensionHandoff(action);
        if (handledByExtension) {
            return { status: 'extension-handoff', action };
        }
    }

    if (!isNativeApp() && isMobileBrowser()) {
        let fallbackTimer: number | null = null;

        const cleanup = () => {
            if (fallbackTimer !== null) {
                window.clearTimeout(fallbackTimer);
                fallbackTimer = null;
            }
            document.removeEventListener('visibilitychange', onVisibility);
        };

        fallbackTimer = window.setTimeout(() => {
            if (document.visibilityState === 'visible') {
                queueAndDispatch(action.deepLinkUrl);
            }
            cleanup();
        }, 1200);

        const onVisibility = () => {
            if (document.visibilityState === 'hidden') {
                cleanup();
            }
        };

        document.addEventListener('visibilitychange', onVisibility);
        window.location.href = action.deepLinkUrl;
        return { status: 'fallback', action };
    }

    queueAndDispatch(action.deepLinkUrl);
    return { status: 'fallback', action };
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

(async () => {
    try {
        const has = await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable();
        if (!has) {
            await BarcodeScanner.installGoogleBarcodeScannerModule();
        }
    } catch {}
})();

const BrowserUI = () => {
    const [handoffResult, setHandoffResult] = useState<WalletUrlResult>({ status: 'none' });

    useEffect(() => {
        handleWalletUrl().then(setHandoffResult).catch(() => {
            setHandoffResult({ status: 'none' });
        });
    }, []);

    if (handoffResult.status === 'extension-handoff') {
        const openWebWallet = () => {
            queueAndDispatch(handoffResult.action.deepLinkUrl);
            setHandoffResult({ status: 'fallback', action: handoffResult.action });
        };

        return (
            <div
                style={{
                    minHeight: '100vh',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: '24px',
                    boxSizing: 'border-box',
                    fontFamily: 'system-ui, sans-serif',
                    background: '#f7f8fb',
                    color: '#1f2937',
                }}
            >
                <div
                    style={{
                        width: '100%',
                        maxWidth: '540px',
                        background: '#ffffff',
                        border: '1px solid #d9e0ea',
                        borderRadius: '16px',
                        padding: '28px',
                        boxSizing: 'border-box',
                        boxShadow: '0 18px 48px rgba(15, 23, 42, 0.08)',
                    }}
                >
                    <h1 style={{ margin: '0 0 12px', fontSize: '28px', lineHeight: 1.2 }}>
                        Opened in Archon Wallet extension
                    </h1>
                    <p style={{ margin: '0 0 20px', fontSize: '16px', lineHeight: 1.5, color: '#475569' }}>
                        Your request was handed off to the browser extension. You can finish it there, or continue in the web wallet instead.
                    </p>
                    <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                        <button
                            onClick={openWebWallet}
                            style={{
                                border: 'none',
                                background: '#2563eb',
                                color: '#ffffff',
                                borderRadius: '10px',
                                padding: '12px 18px',
                                fontSize: '15px',
                                cursor: 'pointer',
                            }}
                        >
                            Continue in Web Wallet
                        </button>
                        <button
                            onClick={() => window.close()}
                            style={{
                                border: '1px solid #cbd5e1',
                                background: '#ffffff',
                                color: '#0f172a',
                                borderRadius: '10px',
                                padding: '12px 18px',
                                fontSize: '15px',
                                cursor: 'pointer',
                            }}
                        >
                            Close Tab
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <ContextProviders>
            <BrowserContent />
        </ContextProviders>
    );
};

const root = ReactDOM.createRoot(document.getElementById("root")!);
root.render(<BrowserUI />);

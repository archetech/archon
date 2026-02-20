import ReactDOM from "react-dom/client";
import BrowserContent from "./BrowserContent";
import { ContextProviders } from "./contexts/ContextProviders";
import "./extension.css";
import "./utils/polyfills";
import { App } from '@capacitor/app';
import { queueDeepLink } from './utils/deepLinkQueue';
import { BarcodeScanner } from '@capacitor-mlkit/barcode-scanning';

App.addListener('appUrlOpen', ({ url }) => {
    queueDeepLink(url);
    window.dispatchEvent(new Event('archon:deepLinkQueued'));
});

(async () => {
    const launch = await App.getLaunchUrl();
    if (launch?.url) {
        queueDeepLink(launch.url);
        window.dispatchEvent(new Event('archon:deepLinkQueued'));
    }
})();

// Web: check browser URL for ?challenge= or ?credential= query params
if (window.location.search) {
    const params = new URLSearchParams(window.location.search);
    const challenge = params.get('challenge');
    const credential = params.get('credential');

    let deepLinkUrl: string | null = null;
    if (challenge?.startsWith('did:')) {
        deepLinkUrl = `archon://auth?challenge=${encodeURIComponent(challenge)}`;
    } else if (credential?.startsWith('did:')) {
        deepLinkUrl = `archon://accept?credential=${encodeURIComponent(credential)}`;
    }

    if (deepLinkUrl) {
        queueDeepLink(deepLinkUrl);
        window.dispatchEvent(new Event('archon:deepLinkQueued'));
    }
}

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

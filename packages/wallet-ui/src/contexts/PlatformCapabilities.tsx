import { createContext, ReactNode, useContext } from "react";

// What the host can physically do, as opposed to what it looks like.
//
// react-wallet is a Capacitor app: it has a camera, so it can scan a QR code.
// The extension has no camera but can ask its other views to refresh, which the
// wallet has no need for since it only has one window. A shared component asks
// for the capability and hides the affordance when the answer is undefined,
// rather than importing @capacitor or chrome and becoming unbuildable in the
// other wallet.
export interface PlatformCapabilities {
    // Returns the scanned text, or null if the scan failed or was cancelled.
    // Undefined when this host has no camera -- callers should not offer a scan.
    scanQr?: () => Promise<string | null>;
    // Scans a QR carrying an alias and its DID. Undefined without a camera.
    scanAliasQr?: () => Promise<{ alias: string; did: string } | null>;
    // Tell the host's other views that wallet state changed. Undefined where
    // there are no other views.
    requestRefresh?: () => void;
    // Restore the view the user last had, if this host keeps one across
    // sessions. Returns whether anything was restored. The extension's popup is
    // destroyed on close and does; react-wallet keeps a live page and does not.
    restoreSession?: () => Promise<boolean | void>;
}

const PlatformCapabilitiesContext = createContext<PlatformCapabilities>({});

export function PlatformCapabilitiesProvider(
    { children, ...capabilities }: { children: ReactNode } & PlatformCapabilities
) {
    return (
        <PlatformCapabilitiesContext.Provider value={capabilities}>
            {children}
        </PlatformCapabilitiesContext.Provider>
    );
}

// Defaults to an empty set rather than throwing: a component that merely asks
// whether it can scan should not require the provider to exist.
export function usePlatformCapabilities(): PlatformCapabilities {
    return useContext(PlatformCapabilitiesContext);
}

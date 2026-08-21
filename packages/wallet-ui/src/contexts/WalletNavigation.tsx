import { createContext, ReactNode, useContext } from "react";

// Navigating to a view -- a DID in the viewer, a credential, a group -- is
// something both wallets do and neither does the same way.
//
// react-wallet has one window, so it switches its own tab through UIContext.
// The extension has two hosts: its full-page view switches in place like the
// wallet, and its popup cannot, so it opens a chrome tab instead. That choice
// lives in the extension, expressed once, rather than in every component as the
// `isBrowser && setOpenBrowser ? ... : openBrowserWindow(...)` it used to be.
//
// The UIContexts that hold this state are deliberately not shared (#911): they
// model two different UIs. This is the narrow slice of them that shared
// components actually need.
export interface WalletView {
    title?: string;
    did?: string;
    contents?: any;
    tab?: string;
    subTab?: string;
    clearState?: boolean;
}

export interface WalletNavigation {
    // Show this view, however this host shows things.
    openView: (view: WalletView) => void;
    // What the host currently wants shown, for the components that render it.
    pendingView?: WalletView;
    clearPendingView?: () => void;
    // Tell whatever other view exists to reset itself. Distinct from openView:
    // this must not *open* anything, and in a host with no other view -- the
    // extension's popup -- it does nothing at all.
    resetView?: () => void;
    // Something outside the UI asked for a screen to open on a particular thing
    // -- react-wallet's deep links do this. Undefined in a host with no such
    // mechanism, and the screens that read them simply never fire.
    pendingChallenge?: string | null;
    setPendingChallenge?: (value: string | null) => void;
    pendingHeldDID?: string | null;
    setPendingHeldDID?: (value: string | null) => void;
    // Hand a URL back to the host's own deep-link handling.
    dispatchDeepLink?: (url: string) => void;
}

const WalletNavigationContext = createContext<WalletNavigation | null>(null);

export function WalletNavigationProvider(
    { children, ...navigation }: { children: ReactNode } & WalletNavigation
) {
    return (
        <WalletNavigationContext.Provider value={navigation}>
            {children}
        </WalletNavigationContext.Provider>
    );
}

export function useWalletNavigation(): WalletNavigation {
    const ctx = useContext(WalletNavigationContext);
    if (!ctx) {
        throw new Error("useWalletNavigation must be used within WalletNavigationProvider");
    }
    return ctx;
}

import React, { createContext, ReactNode, useContext, useEffect, useState } from "react";
import { WalletProvider } from "@didcid/wallet-ui";
import { VariablesProvider } from "@didcid/wallet-ui";
import { UIProvider, useUIContext, loadRefreshIntervalSeconds } from "./UIContext";
import { ThemeProvider } from "@mui/material/styles";
import { Box, CssBaseline, useMediaQuery } from "@mui/material";
import { createAppTheme } from "../theme";
import { SafeAreaProvider, useSafeArea } from "./SafeAreaContext";
import { useDeepLinks } from "../hooks/useDeepLinks";
import { scanAliasQrCode, scanQrText } from "../utils/utils";
import { dispatchDeepLink } from "../utils/deepLinkQueue";
import WalletWeb from "@didcid/keymaster/wallet/web";
import { DEFAULT_GATEKEEPER_URL, GATEKEEPER_KEY } from "../constants";
import {
    getSessionPassphrase,
    setSessionPassphrase,
    clearSessionPassphrase,
} from "../utils/sessionPassphrase";
import {
    PlatformCapabilitiesProvider,
    SnackbarProvider,
    WalletNavigationProvider,
} from "@didcid/wallet-ui";

// Renders nothing: it exists to run the deep-link handler inside the wallet
// provider, since the handler needs the wallet to be ready before it opens a
// screen. This is the app-local half of what used to live in WalletProvider.
function DeepLinks() {
    useDeepLinks();
    return null;
}

// Supplies navigation to the shared components, which cannot reach a UIContext
// -- the two wallets keep their own. This wallet has a single window, so
// everything switches its own tab.
function Navigation({ children }: { children: ReactNode }) {
    const {
        openBrowser,
        setOpenBrowser,
        pendingChallenge,
        setPendingChallenge,
        pendingHeldDID,
        setPendingHeldDID,
    } = useUIContext();
    return (
        <WalletNavigationProvider
            openView={view => setOpenBrowser(view)}
            pendingView={openBrowser}
            clearPendingView={() => setOpenBrowser(undefined)}
            resetView={() => setOpenBrowser({ clearState: true })}
            // Deep links are this wallet's alone, so it is the only host that
            // supplies these; the extension leaves them undefined and the screens
            // that read them simply never fire.
            pendingChallenge={pendingChallenge}
            setPendingChallenge={setPendingChallenge}
            pendingHeldDID={pendingHeldDID}
            setPendingHeldDID={setPendingHeldDID}
            dispatchDeepLink={dispatchDeepLink}
        >
            {children}
        </WalletNavigationProvider>
    );
}

const walletStore = new WalletWeb();

// The capabilities the shared WalletProvider needs from this host: where the
// wallet lives, where the passphrase survives a reload, and how the gatekeeper
// URL is chosen. The extension answers all three differently.
const walletSession = {
    get: getSessionPassphrase,
    set: setSessionPassphrase,
    clear: clearSessionPassphrase,
};

function resolveGatekeeperUrl() {
    const url = localStorage.getItem(GATEKEEPER_KEY) || DEFAULT_GATEKEEPER_URL;
    // Persist the fallback so Settings shows what is actually in use.
    localStorage.setItem(GATEKEEPER_KEY, url);
    return url;
}

// The shared SnackbarProvider takes the inset as a number rather than reaching
// for a context that only exists here: this wallet runs as a Capacitor app and
// must clear the notch, the extension has no inset at all. Reading it is the
// host's job, so it happens here.
function SafeAreaSnackbarProvider({ children }: { children: ReactNode }) {
    const { top } = useSafeArea();
    return <SnackbarProvider topOffset={top}>{children}</SnackbarProvider>;
}

interface ThemeContextValue {
    darkMode: boolean;
    handleDarkModeToggle: (event: React.ChangeEvent<HTMLInputElement>) => void;
    updateThemeFromStorage: () => void;
    // Responsive helpers shared across the app
    isMdUp: boolean;
    isMin768: boolean;
    isTabletUp: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ContextProviders(
    {
        children
    }: {
        children: ReactNode
    }) {
    const [darkMode, setDarkMode] = useState<boolean>(false);
    const THEME_KEY = 'themeMode';

    const theme = createAppTheme(darkMode);

    function handleDarkModeToggle(event: React.ChangeEvent<HTMLInputElement>) {
        const isDark = event.target.checked;
        setDarkMode(isDark);
        localStorage.setItem(THEME_KEY, isDark ? 'dark' : 'light');
    }

    const isMdUp = useMediaQuery(theme.breakpoints.up('md'));
    const isMin768 = useMediaQuery('(min-width:768px)');
    const isTabletUp = isMdUp || isMin768;

    const value: ThemeContextValue = {
        handleDarkModeToggle,
        darkMode,
        updateThemeFromStorage,
        isMdUp,
        isMin768,
        isTabletUp,
    }

    function updateThemeFromStorage() {
        const mode = localStorage.getItem(THEME_KEY);
        if (mode) {
            setDarkMode(mode === 'dark');
        }
    }

    useEffect(() => {
        updateThemeFromStorage();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <ThemeContext.Provider value={value}>
            <ThemeProvider theme={theme}>
                <CssBaseline />
                <Box
                    sx={{
                        width: "100%",
                        height: "100%",
                        bgcolor: "background.default",
                        color: "text.primary",
                        p: 0,
                    }}
                >
                    <SafeAreaProvider>
                        <SafeAreaSnackbarProvider>
                            <WalletProvider
                                walletStore={walletStore}
                                session={walletSession}
                                resolveGatekeeperUrl={resolveGatekeeperUrl}
                            >
                                <VariablesProvider>
                                    <UIProvider>
                                        <Navigation>
                                            {/* This wallet is the Capacitor app, so it
                                                is the one with a camera. */}
                                            <PlatformCapabilitiesProvider
                                                scanQr={scanQrText}
                                                scanAliasQr={scanAliasQrCode}
                                                loadRefreshInterval={async () => loadRefreshIntervalSeconds()}
                                            >
                                                {children}
                                            </PlatformCapabilitiesProvider>
                                        </Navigation>
                                    </UIProvider>
                                </VariablesProvider>
                                {/* After the subtree, not before it. This drains
                                    the deep-link queue as soon as the wallet is
                                    ready, and React runs sibling effects in order
                                    -- so mounted first it could dispatch
                                    archon:open* before UIContext had installed the
                                    listeners for them. Inside WalletProvider, where
                                    this code used to live, it ran after its
                                    children for the same reason. */}
                                <DeepLinks />
                            </WalletProvider>
                        </SafeAreaSnackbarProvider>
                    </SafeAreaProvider>
                </Box>
            </ThemeProvider>
        </ThemeContext.Provider>
    );
}

export function useThemeContext() {
    const ctx = useContext(ThemeContext);
    if (!ctx) {
        throw new Error('useThemeContext must be used within ContextProviders');
    }
    return ctx;
}

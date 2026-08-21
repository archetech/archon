import React, { createContext, Dispatch, ReactNode, SetStateAction, useContext, useEffect, useState } from "react";
import { WalletProvider } from "@didcid/wallet-ui";
import { VariablesProvider } from "@didcid/wallet-ui";
import { AuthProvider } from "./AuthContext";
import { RefreshMode, UIProvider, openBrowserValues, useUIContext } from "./UIContext";
import { createTheme, ThemeProvider } from "@mui/material/styles";
import { Box } from "@mui/material";
import { requestBrowserRefresh } from "../utils/utils";
import { SnackbarProvider, ViewerNavigationProvider } from "@didcid/wallet-ui";
import WalletChrome from "@didcid/keymaster/wallet/chrome";

// Supplies "open this DID in the viewer" to the shared components, which cannot
// reach a UIContext -- the two wallets keep their own. Here it opens the
// full-page view in a chrome tab; react-wallet switches its own tab instead.
function ViewerNavigation({ children }: { children: ReactNode }) {
    const { openBrowserWindow } = useUIContext();
    return (
        <ViewerNavigationProvider openDidViewer={did => openBrowserWindow({ did, tab: "viewer" })}>
            {children}
        </ViewerNavigationProvider>
    );
}

const walletStore = new WalletChrome();

// The capabilities the shared WalletProvider needs from this host. All three
// answers are extension-shaped: the wallet lives in chrome storage, the
// passphrase is held by the background script because the popup does not
// survive being closed, and the gatekeeper URL is synced across the profile.
const walletSession = {
    get: async () => {
        const response = await chrome.runtime.sendMessage({ action: "GET_PASSPHRASE" });
        return response?.passphrase || "";
    },
    set: async (passphrase: string) => {
        await chrome.runtime.sendMessage({ action: "STORE_PASSPHRASE", passphrase });
    },
    clear: async () => {
        await chrome.runtime.sendMessage({ action: "CLEAR_PASSPHRASE" });
    },
};

async function resolveGatekeeperUrl() {
    const { gatekeeperUrl } = await chrome.storage.sync.get(["gatekeeperUrl"]);
    return gatekeeperUrl as string;
}

// The popup is destroyed whenever it closes, so the state the user was looking
// at has to be written through to the background script and read back on open.
// Passed to the shared VariablesProvider rather than reached for inside it: the
// full-page browser view keeps a live page and persists nothing, which is why
// the store is omitted there.
async function storeExtensionState(key: string, value: string | boolean) {
    await chrome.runtime.sendMessage({ action: "STORE_STATE", key, value });
}

interface ThemeContextValue {
    darkMode: boolean;
    handleDarkModeToggle: (event: React.ChangeEvent<HTMLInputElement>) => void;
    updateThemeFromStorage: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ContextProviders(
    {
        children,
        isBrowser,
        pendingAuth,
        pendingCredential,
        pendingAlias,
        openBrowser,
        setOpenBrowser,
        browserRefresh,
        setBrowserRefresh,
    }: {
        children: ReactNode,
        isBrowser: boolean,
        pendingAuth?: string,
        pendingCredential?: string,
        pendingAlias?: { alias: string; did: string },
        openBrowser?: openBrowserValues,
        setOpenBrowser?: Dispatch<SetStateAction<openBrowserValues | undefined>>,
        browserRefresh?: RefreshMode,
        setBrowserRefresh?: Dispatch<SetStateAction<RefreshMode>>,
    }) {
    const [darkMode, setDarkMode] = useState<boolean>(false);

    const theme = createTheme({
        palette: {
            mode: darkMode ? 'dark' : 'light',
        },
    });

    function handleDarkModeToggle(event: React.ChangeEvent<HTMLInputElement>) {
        const isDark = event.target.checked;
        setDarkMode(isDark);
        chrome.storage.local.set({ themeMode: isDark ? 'dark' : 'light' });
        requestBrowserRefresh(isBrowser, true);
    }

    const value: ThemeContextValue = {
        handleDarkModeToggle,
        darkMode,
        updateThemeFromStorage,
    }

    function updateThemeFromStorage() {
        chrome.storage.local.get(['themeMode'], (result) => {
            if (result.themeMode) {
                setDarkMode(result.themeMode === 'dark');
            }
        });
    }

    useEffect(() => {
        updateThemeFromStorage();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <ThemeContext.Provider value={value}>
            <ThemeProvider theme={theme}>
                <Box
                    sx={{
                        width: isBrowser ? "100%" : 420,
                        height: isBrowser ? "100%" : 500,
                        bgcolor: "background.default",
                        color: "text.primary",
                        p: isBrowser ? 0 : 1,
                    }}
                >
                    <SnackbarProvider>
                        <WalletProvider
                            isBrowser={isBrowser}
                            walletStore={walletStore}
                            session={walletSession}
                            resolveGatekeeperUrl={resolveGatekeeperUrl}
                        >
                            <VariablesProvider store={isBrowser ? undefined : storeExtensionState}>
                                <AuthProvider>
                                    <UIProvider
                                        pendingAuth={pendingAuth}
                                        pendingCredential={pendingCredential}
                                        pendingAlias={pendingAlias}
                                        openBrowser={openBrowser}
                                        browserRefresh={browserRefresh}
                                        setBrowserRefresh={setBrowserRefresh}
                                        setOpenBrowser={setOpenBrowser}
                                    >
                                        <ViewerNavigation>
                                            {children}
                                        </ViewerNavigation>
                                    </UIProvider>
                                </AuthProvider>
                            </VariablesProvider>
                        </WalletProvider>
                    </SnackbarProvider>
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

import React, { createContext, ReactNode, useContext, useEffect, useState } from "react";
import { WalletProvider } from "./WalletProvider";
import { VariablesProvider } from "@didcid/wallet-ui";
import { UIProvider } from "./UIContext";
import { ThemeProvider } from "@mui/material/styles";
import { Box, CssBaseline, useMediaQuery } from "@mui/material";
import { createAppTheme } from "../theme";
import { SafeAreaProvider, useSafeArea } from "./SafeAreaContext";
import { SnackbarProvider } from "@didcid/wallet-ui";

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
                            <WalletProvider>
                                <VariablesProvider>
                                    <UIProvider>
                                        {children}
                                    </UIProvider>
                                </VariablesProvider>
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

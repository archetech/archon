import { createContext, ReactNode, useContext, useState } from "react";
import { useIsMounted } from "../hooks/useIsMounted";
import { Alert, AlertColor, Snackbar } from "@mui/material";

interface SnackbarContextValue {
    setError: (error: any) => void;
    setWarning: (warning: string) => void;
    setSuccess: (message: string) => void;
}

interface SnackbarState {
    open: boolean;
    message: string;
    severity: AlertColor;
}

const SnackbarContext = createContext<SnackbarContextValue | null>(null);

// `topOffset` is a platform capability rather than a style choice: react-wallet
// runs as a Capacitor app and must clear the notch, which it reads from its own
// safe-area context, while the extension has no inset and passes nothing. The
// host supplies the number so this file needs neither context.
export function SnackbarProvider(
    { children, topOffset = 0 }: { children: ReactNode; topOffset?: number }
) {
    const [snackbar, setSnackbar] = useState<SnackbarState>({
        open: false,
        message: "",
        severity: "warning",
    });

    const isMounted = useIsMounted();

    // A request that rejects after its screen has gone still reports the error.
    // Raising a snackbar for it is pointless in the browser and throws under
    // test, so late reports are dropped rather than rendered.
    const show = (state: SnackbarState) => {
        if (isMounted()) {
            setSnackbar(state);
        }
    };

    const handleSnackbarClose = () => {
        setSnackbar((prev) => ({ ...prev, open: false }));
    };

    const setError = (error: any) => {
        const errorMessage = error?.error || error?.message || (typeof error === "string" ? error : JSON.stringify(error));
        show({ open: true, message: errorMessage, severity: "error" });
    };

    const setWarning = (warning: string) => {
        show({ open: true, message: warning, severity: "warning" });
    };

    const setSuccess = (message: string) => {
        show({ open: true, message, severity: "success" });
    };

    const value: SnackbarContextValue = {
        setError,
        setWarning,
        setSuccess
    };

    return (
        <SnackbarContext.Provider value={value}>
            <Snackbar
                open={snackbar.open}
                autoHideDuration={5000}
                onClose={handleSnackbarClose}
                anchorOrigin={{ vertical: "top", horizontal: "center" }}
                sx={{ mt: `${topOffset}px` }}
            >
                <Alert onClose={handleSnackbarClose} severity={snackbar.severity} sx={{ width: "100%" }}>
                    {snackbar.message}
                </Alert>
            </Snackbar>
            {children}
        </SnackbarContext.Provider>
    );
}

export function useSnackbar() {
    const ctx = useContext(SnackbarContext);
    if (!ctx) {
        throw new Error("useSnackbar must be used within SnackbarProvider");
    }
    return ctx;
}

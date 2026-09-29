import { CSSProperties } from "react";

export function getTypeStyle(type: string): CSSProperties {
    const base = { fontWeight: "bold" as const };
    switch (type) {
    // Palette paths, resolved by `sx` so they suit light and dark mode.
    case "create":
        return { ...base, color: "success.main" };
    case "update":
        return { ...base, color: "warning.main" };
    case "delete":
        return { ...base, color: "error.main" };
    default:
        return base;
    }
}

export function handleCopyDID(did: string, setError: (error: any) => void) {
    navigator.clipboard.writeText(did).catch((err) => {
        setError(err);
    });
}

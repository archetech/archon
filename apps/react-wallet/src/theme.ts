import { createTheme, ThemeOptions } from "@mui/material/styles";

// Theme-only restyle in the Linear/Vercel idiom: near-black surfaces, high
// contrast text against muted secondary text, hairline borders instead of
// drop shadows, tight radii, dense type, and no shouting uppercase.
//
// Everything here is theme configuration. No component file is touched, so the
// whole app restyles at once and the change is reverted by dropping this file
// and restoring the two-line createTheme call in ContextProviders.

// Inter is the typeface this look is built around, loaded as a variable font in
// main.tsx. The rest of the stack is the fallback path if it fails to load.
const FONT_STACK = [
    // Exactly as @fontsource-variable/inter registers it: the space matters,
    // and a mismatch here fails silently by falling through to the next font.
    "Inter Variable",
    "Inter",
    "system-ui",
    "-apple-system",
    "Segoe UI",
    "Roboto",
    "Helvetica Neue",
    "Arial",
    "sans-serif",
].join(", ");

const MONO_STACK = [
    "ui-monospace",
    "SFMono-Regular",
    "Menlo",
    "Monaco",
    "Consolas",
    "Liberation Mono",
    "monospace",
].join(", ");

const dark = {
    // Layered near-blacks rather than grey. The gap between default and paper
    // is what gives depth once shadows are removed.
    bg: "#08090A",
    surface: "#0F1011",
    surfaceRaised: "#151617",
    border: "rgba(255, 255, 255, 0.09)",
    borderStrong: "rgba(255, 255, 255, 0.16)",
    text: "#F7F8F8",
    textMuted: "#8A8F98",
    accent: "#6E79D6",
    accentHover: "#828CE0",
};

const light = {
    bg: "#FFFFFF",
    surface: "#FFFFFF",
    surfaceRaised: "#FAFAFA",
    border: "rgba(0, 0, 0, 0.09)",
    borderStrong: "rgba(0, 0, 0, 0.16)",
    text: "#08090A",
    textMuted: "#60646C",
    accent: "#5E6AD2",
    accentHover: "#4C57BE",
};

// This idiom is nearly shadowless: separation comes from borders and surface
// layering. MUI requires all 25 slots, so the low elevations are near-invisible
// and only overlays (menus, dialogs) get anything real.
function shadows(isDark: boolean): ThemeOptions["shadows"] {
    const soft = isDark ? "rgba(0, 0, 0, 0.6)" : "rgba(15, 23, 42, 0.08)";
    const hard = isDark ? "rgba(0, 0, 0, 0.8)" : "rgba(15, 23, 42, 0.14)";
    const overlay = `0 8px 24px ${soft}, 0 2px 6px ${hard}`;
    const raised = `0 16px 48px ${soft}, 0 4px 12px ${hard}`;

    return [
        "none",
        `0 1px 2px ${soft}`,
        `0 1px 3px ${soft}`,
        overlay,
        overlay,
        overlay,
        overlay,
        overlay,
        raised,
        ...Array(16).fill(raised),
    ] as ThemeOptions["shadows"];
}

export function createAppTheme(isDark: boolean) {
    const c = isDark ? dark : light;

    return createTheme({
        palette: {
            mode: isDark ? "dark" : "light",
            primary: { main: c.accent, dark: c.accentHover, contrastText: "#FFFFFF" },
            background: { default: c.bg, paper: c.surface },
            text: { primary: c.text, secondary: c.textMuted },
            divider: c.border,
            success: { main: isDark ? "#4CB782" : "#3E9E6E" },
            warning: { main: isDark ? "#F2C94C" : "#C99A16" },
            error: { main: isDark ? "#EB5757" : "#D64545" },
        },

        shape: { borderRadius: 8 },
        shadows: shadows(isDark),

        typography: {
            fontFamily: FONT_STACK,
            // 14px base: this idiom runs denser than Material's 16px default.
            fontSize: 14,
            // Negative tracking on display sizes is most of what separates a
            // "designed" heading from a default one.
            h1: { fontSize: "2rem", fontWeight: 600, letterSpacing: "-0.02em", lineHeight: 1.2 },
            h2: { fontSize: "1.5rem", fontWeight: 600, letterSpacing: "-0.02em", lineHeight: 1.25 },
            h3: { fontSize: "1.25rem", fontWeight: 600, letterSpacing: "-0.015em", lineHeight: 1.3 },
            h4: { fontSize: "1.125rem", fontWeight: 600, letterSpacing: "-0.01em" },
            h5: { fontSize: "1rem", fontWeight: 600, letterSpacing: "-0.01em" },
            h6: { fontSize: "0.9375rem", fontWeight: 600, letterSpacing: "-0.005em" },
            body1: { fontSize: "0.875rem", lineHeight: 1.6 },
            body2: { fontSize: "0.8125rem", lineHeight: 1.6, color: c.textMuted },
            button: { textTransform: "none", fontWeight: 500, letterSpacing: 0 },
            caption: { fontSize: "0.75rem", color: c.textMuted },
        },

        components: {
            MuiCssBaseline: {
                styleOverrides: {
                    body: {
                        backgroundColor: c.bg,
                        color: c.text,
                        WebkitFontSmoothing: "antialiased",
                        MozOsxFontSmoothing: "grayscale",
                    },
                    // Default scrollbars are a giveaway on dark surfaces.
                    "*::-webkit-scrollbar": { width: 10, height: 10 },
                    "*::-webkit-scrollbar-track": { background: "transparent" },
                    "*::-webkit-scrollbar-thumb": {
                        backgroundColor: c.borderStrong,
                        borderRadius: 8,
                        border: `2px solid ${c.bg}`,
                    },
                    "*::-webkit-scrollbar-thumb:hover": { backgroundColor: c.textMuted },
                    "::selection": { backgroundColor: `${c.accent}55` },
                    code: { fontFamily: MONO_STACK, fontSize: "0.85em" },
                },
            },

            MuiPaper: {
                styleOverrides: {
                    root: {
                        // MUI lightens dark paper with a gradient overlay per
                        // elevation; that grey wash is exactly what this look
                        // avoids. Flat surface plus a hairline border instead.
                        backgroundImage: "none",
                        border: `1px solid ${c.border}`,
                    },
                    // Menus and dialogs float, so they keep a real shadow.
                    elevation0: { border: "none" },
                },
            },

            MuiAppBar: {
                defaultProps: { elevation: 0, color: "transparent" },
                styleOverrides: {
                    root: {
                        backgroundColor: c.bg,
                        borderBottom: `1px solid ${c.border}`,
                        backgroundImage: "none",
                    },
                },
            },

            MuiButton: {
                defaultProps: { disableElevation: true },
                styleOverrides: {
                    root: {
                        borderRadius: 8,
                        paddingInline: 14,
                        minHeight: 34,
                        transition: "background-color 120ms ease, border-color 120ms ease",
                    },
                    contained: {
                        "&:hover": { backgroundColor: c.accentHover },
                    },
                    outlined: {
                        borderColor: c.border,
                        "&:hover": {
                            borderColor: c.borderStrong,
                            backgroundColor: isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.03)",
                        },
                    },
                    text: {
                        "&:hover": {
                            backgroundColor: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)",
                        },
                    },
                },
            },

            MuiIconButton: {
                styleOverrides: {
                    root: {
                        borderRadius: 8,
                        "&:hover": {
                            backgroundColor: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)",
                        },
                    },
                },
            },

            MuiOutlinedInput: {
                styleOverrides: {
                    root: {
                        backgroundColor: isDark ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.015)",
                        "& .MuiOutlinedInput-notchedOutline": { borderColor: c.border },
                        "&:hover .MuiOutlinedInput-notchedOutline": { borderColor: c.borderStrong },
                        "&.Mui-focused .MuiOutlinedInput-notchedOutline": {
                            borderColor: c.accent,
                            borderWidth: 1,
                        },
                    },
                    input: { fontSize: "0.875rem" },
                },
            },

            MuiTab: {
                styleOverrides: {
                    root: {
                        textTransform: "none",
                        fontWeight: 500,
                        fontSize: "0.8125rem",
                        letterSpacing: 0,
                        minHeight: 40,
                        borderRadius: 6,
                        color: c.textMuted,
                        "&.Mui-selected": { color: c.text },
                    },
                },
            },

            MuiTabs: {
                styleOverrides: {
                    // The sliding underline is a Material tell. A selected-row
                    // treatment suits the sidebar this app already uses.
                    indicator: {
                        backgroundColor: c.accent,
                        borderRadius: 2,
                    },
                },
            },

            MuiBottomNavigation: {
                styleOverrides: {
                    root: {
                        backgroundColor: c.surface,
                        borderTop: `1px solid ${c.border}`,
                    },
                },
            },

            MuiBottomNavigationAction: {
                styleOverrides: {
                    root: {
                        color: c.textMuted,
                        "&.Mui-selected": { color: c.text },
                    },
                    label: { fontSize: "0.6875rem", "&.Mui-selected": { fontSize: "0.6875rem" } },
                },
            },

            MuiChip: {
                styleOverrides: {
                    root: {
                        borderRadius: 6,
                        fontWeight: 500,
                        fontSize: "0.75rem",
                        height: 24,
                    },
                    outlined: { borderColor: c.border },
                },
            },

            MuiDivider: {
                styleOverrides: { root: { borderColor: c.border } },
            },

            MuiTooltip: {
                styleOverrides: {
                    tooltip: {
                        backgroundColor: isDark ? c.surfaceRaised : "#1A1B1D",
                        border: `1px solid ${c.border}`,
                        fontSize: "0.75rem",
                        borderRadius: 6,
                        padding: "6px 10px",
                    },
                },
            },

            MuiDialog: {
                styleOverrides: {
                    paper: { borderRadius: 12, border: `1px solid ${c.border}` },
                },
            },

            MuiMenu: {
                styleOverrides: {
                    paper: { borderRadius: 8, border: `1px solid ${c.border}` },
                },
            },

            MuiMenuItem: {
                styleOverrides: {
                    root: { fontSize: "0.8125rem", borderRadius: 6, marginInline: 4 },
                },
            },

            MuiListItemButton: {
                styleOverrides: { root: { borderRadius: 6 } },
            },

            MuiTableCell: {
                styleOverrides: {
                    root: { borderColor: c.border, fontSize: "0.8125rem" },
                    head: { fontWeight: 600, color: c.textMuted },
                },
            },

            MuiTextField: {
                defaultProps: { size: "small" },
            },

            MuiSelect: {
                defaultProps: { size: "small" },
            },
        },
    });
}

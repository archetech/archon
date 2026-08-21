import { useMediaQuery, useTheme } from "@mui/material";

// "Is there room to lay this out side by side" -- used by the shared dialogs to
// decide whether their buttons take half the width or all of it.
//
// This needs no injection, unlike the other host differences in this package:
// it is a media query, and both wallets render inside a ThemeProvider. The
// answer differs between them at runtime for the honest reason -- the
// extension's popup is narrow and its full-page view is not.
export function useIsTabletUp(): boolean {
    const theme = useTheme();
    const isMdUp = useMediaQuery(theme.breakpoints.up('md'));
    const isMin768 = useMediaQuery('(min-width:768px)');
    return isMdUp || isMin768;
}

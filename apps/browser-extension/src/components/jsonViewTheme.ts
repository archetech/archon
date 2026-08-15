import { githubDarkTheme } from "@uiw/react-json-view/githubDark";
import { githubLightTheme } from "@uiw/react-json-view/githubLight";

// @uiw/react-json-view ships its own palette and defaults to a light one, which
// nothing in the MUI theme can reach. On a dark surface that leaves dark text on
// a dark background. Pick the matching theme explicitly, and drop the viewer's
// own background so it sits on whatever contains it.
export function jsonViewTheme(isDark: boolean) {
    const theme = isDark ? githubDarkTheme : githubLightTheme;
    return { ...theme, backgroundColor: "transparent" };
}

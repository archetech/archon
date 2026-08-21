import { githubDarkTheme } from "@uiw/react-json-view/githubDark";
import { githubLightTheme } from "@uiw/react-json-view/githubLight";

// @uiw/react-json-view ships its own palette and defaults to a light one, so on
// a dark surface it renders dark text on dark background -- unreadable, and not
// something the MUI theme can reach. Pick the matching theme explicitly.
//
// The background is dropped so the viewer sits on whatever Section or Paper
// contains it, instead of punching its own slab of colour through the layout.
export function jsonViewTheme(isDark: boolean) {
    const theme = isDark ? githubDarkTheme : githubLightTheme;
    return { ...theme, backgroundColor: "transparent" };
}

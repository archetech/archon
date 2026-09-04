import { useEffect, useRef, useCallback } from "react";

// Refresh work is started from effects and awaits the network, so it can resolve
// after the component has gone. Writing state then is wrong in the browser --
// an error snackbar for a screen the user has left -- and fatal under test,
// where jsdom is already torn down and React reaches for `window` (#1035).
export function useIsMounted(): () => boolean {
    const mounted = useRef(true);

    useEffect(() => {
        mounted.current = true;

        return () => {
            mounted.current = false;
        };
    }, []);

    return useCallback(() => mounted.current, []);
}

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

// The guard applied to a state update that may arrive late. Separate from the
// provider so a test can watch the updater it protects: asserting that a report
// after unmount is dropped needs something observable, and after unmount there
// is nothing left to render.
export function whileMounted<T>(
    update: (value: T) => void,
    isMounted: () => boolean,
): (value: T) => void {
    return (value: T) => {
        if (isMounted()) {
            update(value);
        }
    };
}

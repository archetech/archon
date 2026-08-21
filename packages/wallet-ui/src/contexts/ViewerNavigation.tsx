import { createContext, ReactNode, useContext } from "react";

// "Open this DID in the viewer" is something both wallets do and neither does
// the same way. react-wallet switches its own browser tab through UIContext;
// the extension opens a new chrome tab. Those UIContexts are deliberately not
// shared -- they model two different UIs -- so a shared component cannot reach
// for either.
//
// Passing the action down as a prop was the obvious alternative and a bad one:
// CopyResolveDID is rendered at eighteen sites and DisplayDID at ten, most of
// them inside the large diverged tabs this refactor has not reached yet, so
// prop-drilling it would mean editing exactly the files that are hardest to
// review.
//
// So it is a capability with one entry point. Each app supplies its own
// implementation once, next to the UIContext that knows how.
export interface ViewerNavigation {
    openDidViewer: (did: string) => void;
}

const ViewerNavigationContext = createContext<ViewerNavigation | null>(null);

export function ViewerNavigationProvider(
    { children, openDidViewer }: { children: ReactNode } & ViewerNavigation
) {
    return (
        <ViewerNavigationContext.Provider value={{ openDidViewer }}>
            {children}
        </ViewerNavigationContext.Provider>
    );
}

export function useViewerNavigation(): ViewerNavigation {
    const ctx = useContext(ViewerNavigationContext);
    if (!ctx) {
        throw new Error("useViewerNavigation must be used within ViewerNavigationProvider");
    }
    return ctx;
}

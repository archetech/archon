import { useEffect } from "react";
import { useWalletContext } from "@didcid/wallet-ui";
import { takeDeepLink } from "../utils/deepLinkQueue";
import { extractAlias, extractDid } from "../utils/utils";

// Deep links are this wallet's alone: it is the Capacitor app the OS can launch
// with an archon:// URL, so the shared WalletProvider carries none of this.
// Mount it inside the provider tree -- it waits for the wallet to be ready
// before draining the queue, because the handlers open screens.
export function useDeepLinks() {
    const { keymaster } = useWalletContext();
    const isReady = keymaster !== null;

    function openEvent(detail: { did?: string | null; alias?: string }, type: string) {
        const evt = new CustomEvent(type, { detail });
        window.dispatchEvent(evt);
    }

    function parsePrefix(url: string): { action?: string, did?: string | null, alias?: string } {
        try {
            const u = new URL(url.replace(/^archon:\/\//, 'https://'));
            const action = (u.hostname || u.pathname.replace(/^\//, '') || '').toLowerCase();
            const aliasResult = extractAlias(url);
            if (aliasResult) {
                return { action, did: aliasResult.did, alias: aliasResult.alias };
            }
            const did = extractDid(url);
            return { action, did };
        } catch {
            const aliasResult = extractAlias(url);
            if (aliasResult) {
                return { did: aliasResult.did, alias: aliasResult.alias };
            }
            return { did: extractDid(url) };
        }
    }

    useEffect(() => {
        if (!isReady) {
            return;
        }

        const handleQueued = () => {
            const url = takeDeepLink();
            if (!url) {
                return;
            }

            const { action, did, alias } = parsePrefix(url);

            if (action === 'accept' && did) {
                if (alias) {
                    openEvent({ did, alias }, "archon:openAlias");
                    return;
                }
                openEvent({ did }, "archon:openAccept");
                return;
            }

            if (did) {
                openEvent({ did }, "archon:openAuth");
            }
        };

        handleQueued();
        window.addEventListener('archon:deepLinkQueued', handleQueued);
        return () => window.removeEventListener('archon:deepLinkQueued', handleQueued);
    }, [isReady]);
}

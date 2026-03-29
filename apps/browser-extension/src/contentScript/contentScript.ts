// Inject NIP-07 nostr provider into page context
const script = document.createElement("script");
script.src = chrome.runtime.getURL("nostr-provider.js");
script.onload = () => script.remove();
(document.head || document.documentElement).appendChild(script);

const messageTargetOrigin = window.location.origin;
const maxWalletPayloadLength = 4096;

function isDidLike(value: unknown): value is string {
    return typeof value === "string" && value.startsWith("did:") && value.length <= maxWalletPayloadLength;
}

function isAliasLike(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0 && value.length <= 256;
}

// Relay NIP-07 requests from page to background
window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.type !== "archon-nostr-request") {
        return;
    }
    const { id, method, params } = event.data;
    chrome.runtime.sendMessage(
        { action: "NOSTR_REQUEST", id, method, params },
        (response) => {
            if (chrome.runtime.lastError) {
                window.postMessage({
                    type: "archon-nostr-response",
                    id,
                    error: chrome.runtime.lastError.message,
                }, "*");
                return;
            }
            window.postMessage({
                type: "archon-nostr-response",
                id,
                result: response?.result,
                error: response?.error,
            }, "*");
        }
    );
});

// Relay wallet handoff requests from the web wallet to the extension
window.addEventListener("message", (event) => {
    if (event.source !== window) {
        return;
    }

    if (event.data?.type === "archon-wallet-extension-probe") {
        window.postMessage({
            type: "archon-wallet-extension-probe-response",
            requestId: event.data.requestId,
            available: true,
        }, messageTargetOrigin);
        return;
    }

    if (event.data?.type !== "archon-wallet-extension-open") {
        return;
    }

    const { requestId, action, challenge, credential, alias, did } = event.data;

    let message: Record<string, unknown> | null = null;
    if (action === "auth" && isDidLike(challenge)) {
        message = { action: "OPEN_AUTH_TAB", challenge };
    } else if (action === "credential" && isDidLike(credential)) {
        message = { action: "OPEN_CREDENTIAL_TAB", credential };
    } else if (action === "alias" && isAliasLike(alias) && isDidLike(did)) {
        message = { action: "OPEN_ALIAS_TAB", alias, did };
    }

    if (!message) {
        window.postMessage({
            type: "archon-wallet-extension-open-response",
            requestId,
            ok: false,
            error: "Unsupported wallet handoff request",
        }, messageTargetOrigin);
        return;
    }

    chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
            window.postMessage({
                type: "archon-wallet-extension-open-response",
                requestId,
                ok: false,
                error: chrome.runtime.lastError.message,
            }, messageTargetOrigin);
            return;
        }

        window.postMessage({
            type: "archon-wallet-extension-open-response",
            requestId,
            ok: !!response?.success,
        }, messageTargetOrigin);
    });
});

// Handle archon:// protocol links
document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) {
        return;
    }
    const anchor = event.target.closest("a");
    if (!anchor) {
        return;
    }

    const href = anchor.getAttribute("href") || "";

    if (href.startsWith("archon://")) {
        event.preventDefault();
        const parsedURL = new URL(href.replace("archon://", "https://archon/"));
        const tab = parsedURL.pathname.slice(1);
        if (tab === "auth") {
            const challenge = parsedURL.searchParams.get("challenge");
            if (!challenge) {
                return;
            }
            chrome.runtime.sendMessage({
                action: "OPEN_AUTH_TAB",
                challenge,
            });
        } else if (tab === "accept") {
            const credential = parsedURL.searchParams.get("credential");
            const alias = parsedURL.searchParams.get("alias");
            const did = parsedURL.searchParams.get("did");

            if (alias && did) {
                chrome.runtime.sendMessage({
                    action: "OPEN_ALIAS_TAB",
                    alias,
                    did,
                });
            } else if (credential) {
                chrome.runtime.sendMessage({
                    action: "OPEN_CREDENTIAL_TAB",
                    credential,
                });
            }
        }
    }
});

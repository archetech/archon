// Inject NIP-07 nostr provider into page context
const script = document.createElement("script");
script.src = chrome.runtime.getURL("nostr-provider.js");
script.onload = () => script.remove();
(document.head || document.documentElement).appendChild(script);

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

// Handle archon:// protocol links
document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLAnchorElement)) {
        return;
    }

    const href = target.getAttribute("href") || "";

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
            if (!credential) {
                return;
            }
            chrome.runtime.sendMessage({
                action: "OPEN_CREDENTIAL_TAB",
                credential,
            });
        }
    }
});

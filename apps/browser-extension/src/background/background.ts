import {openBrowserValues} from "../contexts/UIContext";

const DEFAULT_GATEKEEPER_URL = "http://localhost:4224";

interface PendingNostrRequest {
    sendResponse: (response: any) => void;
    method: string;
    params?: any;
    origin?: string;
}

const pendingNostrRequests = new Map<string, PendingNostrRequest>();

async function getPassphrase(): Promise<string | null> {
    const result = await chrome.storage.session.get("passphrase");
    return (result.passphrase as string) ?? null;
}

async function setPassphrase(value: string | null): Promise<void> {
    if (value === null) {
        await chrome.storage.session.remove("passphrase");
    } else {
        await chrome.storage.session.set({ passphrase: value });
    }
}

async function getExtensionState(): Promise<Record<string, any>> {
    const result = await chrome.storage.session.get("extensionState");
    return (result.extensionState as Record<string, any>) ?? {};
}

async function setExtensionState(state: Record<string, any>): Promise<void> {
    await chrome.storage.session.set({ extensionState: state });
}

async function getApprovedNostrOrigins(): Promise<string[]> {
    const { approvedNostrOrigins = [] } = await chrome.storage.session.get("approvedNostrOrigins");
    return approvedNostrOrigins as string[];
}

async function addApprovedNostrOrigin(origin: string): Promise<void> {
    const origins = await getApprovedNostrOrigins();
    if (!origins.includes(origin)) {
        origins.push(origin);
        await chrome.storage.session.set({ approvedNostrOrigins: origins });
    }
}

async function ensureDefaultSettings() {
    try {
        const { gatekeeperUrl } = await chrome.storage.sync.get([
            "gatekeeperUrl",
        ]);

        const updates: Record<string, string> = {};

        if (gatekeeperUrl === undefined) {
            updates.gatekeeperUrl = DEFAULT_GATEKEEPER_URL;
        }

        if (Object.keys(updates).length) {
            await chrome.storage.sync.set(updates);
        }
    } catch (error) {
        console.error("Error ensuring default settings:", error);
    }
}

chrome.runtime.onInstalled.addListener(async (details) => {
    if (details.reason === chrome.runtime.OnInstalledReason.INSTALL) {
        await ensureDefaultSettings();
    }
});

chrome.runtime.onStartup.addListener(async () => {
    await ensureDefaultSettings();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "REQUEST_POPUP_CREDENTIAL" || message.action === "OPEN_CREDENTIAL_TAB") {
        chrome.action.openPopup().then(() => {
            chrome.runtime.sendMessage({
                action: "SHOW_POPUP_CREDENTIAL",
                credential: message.credential,
            });
        }).catch(() => {
            const credentialEncoded = encodeURIComponent(JSON.stringify(message.credential));
            chrome.windows.create({
                url: chrome.runtime.getURL(`popup.html?credential=${credentialEncoded}`),
                type: "popup",
                width: 500,
                height: 600,
            });
        });
        sendResponse({ success: true });
    } else if (message.action === "REQUEST_POPUP_AUTH" || message.action === "OPEN_AUTH_TAB") {
        chrome.action.openPopup().then(() => {
            chrome.runtime.sendMessage({
                action: "SHOW_POPUP_AUTH",
                challenge: message.challenge,
            });
        }).catch(() => {
            const challengeEncoded = encodeURIComponent(message.challenge);
            chrome.windows.create({
                url: chrome.runtime.getURL(`popup.html?challenge=${challengeEncoded}`),
                type: "popup",
                width: 500,
                height: 600,
            });
        });
        sendResponse({ success: true });
    } else if (message.action === "OPEN_ALIAS_TAB") {
        const aliasEncoded = encodeURIComponent(message.alias);
        const didEncoded = encodeURIComponent(message.did);
        chrome.action.openPopup().then(() => {
            chrome.runtime.sendMessage({
                action: "SHOW_POPUP_ALIAS",
                alias: message.alias,
                did: message.did,
            });
        }).catch(() => {
            chrome.windows.create({
                url: chrome.runtime.getURL(`popup.html?alias=${aliasEncoded}&did=${didEncoded}`),
                type: "popup",
                width: 500,
                height: 600,
            });
        });
        sendResponse({ success: true });
    } else if (message.type === "OPEN_BROWSER_WINDOW") {
        openBrowserWindowService(message.options);
    } else if (message.action === "NOSTR_REQUEST") {
        const requestId = message.id as string;
        const origin = sender?.tab?.url ? new URL(sender.tab.url).origin : "unknown";
        pendingNostrRequests.set(requestId, {
            sendResponse,
            method: message.method,
            params: message.params,
            origin,
        });
        getApprovedNostrOrigins().then((origins) => {
            const autoApprove = origins.includes(origin);
            const popupUrl = chrome.runtime.getURL(
                `popup.html?nostrRequest=${requestId}${autoApprove ? "&autoApprove=true" : ""}`
            );
            chrome.windows.create({
                url: popupUrl,
                type: "popup",
                width: 500,
                height: 340,
                focused: !autoApprove,
            });
        });
        // keep sendResponse alive by returning true below
    } else if (message.action === "APPROVE_NOSTR_ORIGIN") {
        addApprovedNostrOrigin(message.origin).then(() => {
            sendResponse({ ok: true });
        });
    } else if (message.action === "NOSTR_RESPONSE") {
        const pending = pendingNostrRequests.get(message.id);
        if (pending) {
            pendingNostrRequests.delete(message.id);
            pending.sendResponse({ result: message.result, error: message.error });
        }
        sendResponse({ ok: true });
    } else if (message.action === "GET_NOSTR_REQUEST") {
        const pending = pendingNostrRequests.get(message.id);
        if (pending) {
            sendResponse({
                method: pending.method,
                params: pending.params,
                origin: pending.origin,
            });
        } else {
            sendResponse({ error: "Request not found" });
        }
    } else if (message.action === "STORE_PASSPHRASE") {
        setPassphrase(message.passphrase).then(() => sendResponse({ success: true }));
    } else if (message.action === "GET_PASSPHRASE") {
        getPassphrase().then((passphrase) => sendResponse({ passphrase }));
    } else if (message.action === "CLEAR_PASSPHRASE") {
        setPassphrase(null).then(() => sendResponse({ success: true }));
    } else if (message.action === "STORE_STATE") {
        getExtensionState().then((state) => {
            state[message.key] = message.value;
            setExtensionState(state).then(() => sendResponse({ success: true }));
        });
    } else if (message.action === "GET_ALL_STATE") {
        getExtensionState().then((extensionState) => sendResponse({ extensionState }));
    } else if (message.action === "CLEAR_ALL_STATE") {
        setExtensionState({}).then(() => sendResponse({ success: true }));
    } else if (message.action === "CLEAR_STATE") {
        getExtensionState().then((state) => {
            delete state[message.key];
            setExtensionState(state).then(() => sendResponse({ success: true }));
        });
    }

    return true;
});

function openBrowserWindowService(options: openBrowserValues) {
    const tab = options.tab ?? "viewer";

    const payload = {
        ...options,
        tab
    };

    let url = `browser.html?tab=${tab}`;

    if (options.subTab) {
        url += `&subTab=${options.subTab}`;
    }

    if (!options.contents) {
        if (options.did) {
            const didEncoded = encodeURIComponent(options.did);
            url += `&did=${didEncoded}`;
        }

        if (options.title) {
            const titleEncoded = encodeURIComponent(options.title);
            url += `&title=${titleEncoded}`;
        }
    }

    const deliverPayload = (tabId: number) => {
        chrome.tabs.sendMessage(tabId, { type: "PING_BROWSER" }, (resp) => {
            if (chrome.runtime.lastError || !resp?.ack) {
                setTimeout(() => deliverPayload(tabId), 100);
                return;
            }
            chrome.tabs.sendMessage(tabId, { type: "LOAD_BROWSER_CONTENTS", payload });
            chrome.tabs.update(tabId, { active: true });
        });
    };

    const openNewBrowserTab = () => {
        chrome.tabs.create({ url }, (created) => {
            const listener = (id: number, info: { status?: string }) => {
                if (id === created.id && info.status === "complete") {
                    deliverPayload(id);
                    chrome.tabs.onUpdated.removeListener(listener);
                }
            };
            chrome.tabs.onUpdated.addListener(listener);
        });
    };

    chrome.tabs.query({ url: chrome.runtime.getURL("browser.html") + "*" }, (tabs) => {
        if (!tabs || tabs.length === 0 || tabs[0].id === undefined) {
            openNewBrowserTab();
            return;
        }

        const existingTabId = tabs[0].id;

        chrome.tabs.sendMessage(
            existingTabId,
            { type: "PING_BROWSER" },
            (response) => {
                if (chrome.runtime.lastError || !response?.ack) {
                    openNewBrowserTab();
                    return;
                }

                deliverPayload(existingTabId)
            }
        );
    });
}

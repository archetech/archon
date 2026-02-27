/**
 * NIP-07 window.nostr provider
 * Injected into page context to expose window.nostr
 * Communicates with the content script via window.postMessage
 */

interface NostrEvent {
    id?: string;
    pubkey?: string;
    created_at: number;
    kind: number;
    tags: string[][];
    content: string;
    sig?: string;
}

interface PendingRequest {
    resolve: (value: any) => void;
    reject: (reason: any) => void;
}

const pendingRequests = new Map<string, PendingRequest>();

function generateId(): string {
    return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

function sendRequest(method: string, params?: any): Promise<any> {
    return new Promise((resolve, reject) => {
        const id = generateId();
        pendingRequests.set(id, { resolve, reject });
        window.postMessage({
            type: "archon-nostr-request",
            id,
            method,
            params,
        }, "*");
    });
}

window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.type !== "archon-nostr-response") {
        return;
    }
    const { id, result, error } = event.data;
    const pending = pendingRequests.get(id);
    if (!pending) {
        return;
    }
    pendingRequests.delete(id);
    if (error) {
        pending.reject(new Error(error));
    } else {
        pending.resolve(result);
    }
});

(window as any).nostr = {
    async getPublicKey(): Promise<string> {
        return sendRequest("getPublicKey");
    },

    async signEvent(event: NostrEvent): Promise<NostrEvent> {
        return sendRequest("signEvent", event);
    },

    nip04: {
        async encrypt(_pubkey: string, _plaintext: string): Promise<string> {
            throw new Error("NIP-04 not supported");
        },
        async decrypt(_pubkey: string, _ciphertext: string): Promise<string> {
            throw new Error("NIP-04 not supported");
        },
    },
};

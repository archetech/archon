// Mailbox storage for the DIDComm relay. Encrypted envelopes are stored
// addressed by recipient DID (parsed from the JWE recipient kids) until the
// key-holder fetches them. In-memory for now; swap for redis/mongo later
// behind the MailboxStore interface (mirrors the other services' stores).

export interface StoredMessage {
    id: string;
    recipient: string;
    envelope: string;
    received: string;
}

export interface MailboxStore {
    add(recipient: string, envelope: string, id: string): StoredMessage;
    list(recipient: string): StoredMessage[];
    remove(recipient: string, ids: string[]): number;
    issueChallenge(challenge: string): void;
    consumeChallenge(challenge: string): boolean;
}

export class MemoryMailboxStore implements MailboxStore {
    private messages = new Map<string, StoredMessage[]>();
    private challenges = new Map<string, number>();

    constructor(
        private readonly messageTtlMs = 7 * 24 * 60 * 60 * 1000,
        private readonly challengeTtlMs = 5 * 60 * 1000,
        private readonly now: () => number = () => Date.now(),
    ) {}

    private prune(recipient: string): void {
        const cutoff = this.now() - this.messageTtlMs;
        const list = (this.messages.get(recipient) || []).filter(m => Date.parse(m.received) >= cutoff);
        if (list.length > 0) {
            this.messages.set(recipient, list);
        }
        else {
            this.messages.delete(recipient);
        }
    }

    add(recipient: string, envelope: string, id: string): StoredMessage {
        const message: StoredMessage = { id, recipient, envelope, received: new Date(this.now()).toISOString() };
        const list = this.messages.get(recipient) || [];
        list.push(message);
        this.messages.set(recipient, list);
        return message;
    }

    list(recipient: string): StoredMessage[] {
        this.prune(recipient);
        return [...(this.messages.get(recipient) || [])];
    }

    remove(recipient: string, ids: string[]): number {
        const list = this.messages.get(recipient) || [];
        const idSet = new Set(ids);
        const kept = list.filter(m => !idSet.has(m.id));
        const removed = list.length - kept.length;
        if (kept.length > 0) {
            this.messages.set(recipient, kept);
        }
        else {
            this.messages.delete(recipient);
        }
        return removed;
    }

    issueChallenge(challenge: string): void {
        this.challenges.set(challenge, this.now() + this.challengeTtlMs);
    }

    // Single-use: returns true only if the challenge is known and unexpired,
    // and removes it so it cannot be replayed.
    consumeChallenge(challenge: string): boolean {
        const expires = this.challenges.get(challenge);
        if (expires === undefined) {
            return false;
        }
        this.challenges.delete(challenge);
        return this.now() <= expires;
    }
}

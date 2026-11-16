declare module 'graceful-goodbye' {
    export default function goodbye(handler: () => void): void;
}

declare module 'hyperswarm' {
    export interface HyperswarmConnection {
        remotePublicKey: Buffer;
        write(data: string | Buffer): void;
        once(event: string, callback: (...args: any[]) => void): void;
        on(event: string, callback: (...args: any[]) => void): void;
        end?(): void;
        destroy?(): void;
    }

    interface Discovery {
        flushed(): Promise<void>;
    }

    export interface HyperswarmKeyPair {
        publicKey: Buffer;
        secretKey?: Buffer;
    }

    export interface HyperswarmOptions {
        keyPair?: HyperswarmKeyPair;
    }

    export default class Hyperswarm {
        public keyPair: HyperswarmKeyPair;

        constructor(opts?: HyperswarmOptions);

        join(topic: Buffer, opts: { client: boolean; server: boolean }): Discovery;
        on(event: 'connection', listener: (conn: HyperswarmConnection) => void): void;
        destroy(): Promise<void>;
    }
}

declare module 'macaroons.js' {
    class MacaroonsBuilder {
        constructor(location: string, secretKey: string, identifier: string);
        add_first_party_caveat(caveat: string): MacaroonsBuilder;
        getMacaroon(): Macaroon;
        static create(location: string, secretKey: string, identifier: string): Macaroon;
        static deserialize(serialized: string): Macaroon;
    }

    class MacaroonsVerifier {
        constructor(macaroon: Macaroon);
        satisfyExact(caveat: string): MacaroonsVerifier;
        satisfyGeneral(generalVerifier: (caveat: string) => boolean): MacaroonsVerifier;
        isValid(secretKey: string): boolean;
    }

    interface Macaroon {
        identifier: string;
        location: string;
        signature: string;
        caveatPackets: CaveatPacket[];
        serialize(): string;
    }

    interface CaveatPacket {
        type: number;
        rawValue: Uint8Array;
        getValueAsText(): string;
    }

    const _default: {
        MacaroonsBuilder: typeof MacaroonsBuilder;
        MacaroonsVerifier: typeof MacaroonsVerifier;
    };

    export default _default;
    export { MacaroonsBuilder, MacaroonsVerifier, Macaroon, CaveatPacket };
}

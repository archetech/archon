declare module 'macaroons.js' {
    export class MacaroonsBuilder {
        constructor(location: string, secretKey: string, identifier: string);
        add_first_party_caveat(caveat: string): MacaroonsBuilder;
        getMacaroon(): Macaroon;
        static deserialize(serialized: string): Macaroon;
    }

    export class MacaroonsVerifier {
        constructor(macaroon: Macaroon);
        satisfyGeneral(fn: (caveat: string) => boolean): void;
        isValid(secret: string): boolean;
    }

    export interface Macaroon {
        identifier: string;
        location: string;
        signature: string;
        caveatPackets: CaveatPacket[];
        serialize(): string;
    }

    export interface CaveatPacket {
        getValueAsText(): string;
    }
}

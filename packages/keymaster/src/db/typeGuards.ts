import { WalletFile, WalletEncFile } from "../types.js";

export function isV1WithEnc(obj: any): obj is WalletEncFile {
    return !!obj && obj.version === 1 && typeof obj.enc === 'string' && obj.seed?.mnemonicEnc;
}

export function isV1Decrypted(obj: any): obj is WalletFile {
    return !!obj && obj.version === 1 && obj.seed?.mnemonicEnc && !('enc' in obj);
}

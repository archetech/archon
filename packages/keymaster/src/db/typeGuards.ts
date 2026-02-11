import { WalletFile, WalletEncFile } from "../types.js";

export function isWalletEncFile(obj: any): obj is WalletEncFile {
    return !!obj && (obj.version === 1 || obj.version === 2) && typeof obj.enc === 'string' && obj.seed?.mnemonicEnc;
}

export function isWalletFile(obj: any): obj is WalletFile {
    return !!obj && (obj.version === 1 || obj.version === 2) && obj.seed?.mnemonicEnc && !('enc' in obj);
}

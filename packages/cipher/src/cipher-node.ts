import * as bip39 from 'bip39';
import { base64url } from 'multiformats/bases/base64';
import { randomBytes } from 'crypto';
import { HDKey } from '@scure/bip32';
import CipherBase from './cipher-base.js';
import { Cipher, HDKeyJSON } from './types.js';

export default class CipherNode extends CipherBase implements Cipher {
    generateHDKey(mnemonic: string): HDKey {
        const seed = bip39.mnemonicToSeedSync(mnemonic);
        return HDKey.fromMasterSeed(seed);
    }

    generateHDKeyJSON(json: HDKeyJSON): HDKey {
        return HDKey.fromJSON(json);
    }

    generateRandomSalt(): string {
        return base64url.encode(randomBytes(32));
    }
}

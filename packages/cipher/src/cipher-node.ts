import { base64url } from 'multiformats/bases/base64';
import { randomBytes } from 'crypto';
import CipherBase from './cipher-base.js';
import { Cipher } from './types.js';

export default class CipherNode extends CipherBase implements Cipher {
    generateRandomSalt(): string {
        return base64url.encode(randomBytes(32));
    }
}

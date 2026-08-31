import { base64url } from 'multiformats/bases/base64';
import CipherBase from './cipher-base.js';
import { Cipher } from './types.js';

export default class CipherWeb extends CipherBase implements Cipher {
    generateRandomSalt(): string {
        const array = new Uint8Array(32);
        if (typeof window !== 'undefined' && window.crypto && window.crypto.getRandomValues) {
            window.crypto.getRandomValues(array);
        } else if (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.getRandomValues) {
            globalThis.crypto.getRandomValues(array);
        } else {
            throw new Error('No secure random number generator available.');
        }
        return base64url.encode(array);
    }
}

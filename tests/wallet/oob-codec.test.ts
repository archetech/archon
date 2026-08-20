// The demo wallets cannot import @didcid/keymaster -- the server-wallet demo
// depends only on the thin client package -- so apps/*/src/oobCodec.mjs carries
// its own copy of the out-of-band invitation encoding.
//
// Duplicated wire formats drift, and this one would drift silently: an
// invitation created in one wallet would simply fail to decode in the other,
// with nothing failing until a user tried it. So compare the actual module the
// demo UIs import against the actual library implementation.
import {
    decodeOutOfBandInvitation as libDecode,
    encodeOutOfBandInvitation as libEncode,
    outOfBandInvitation as libInvitation,
} from '../../packages/keymaster/src/didcomm-protocols.ts';
import {
    decodeOutOfBandInvitation as uiDecode,
    encodeOutOfBandInvitation as uiEncode,
    outOfBandInvitation as uiInvitation,
} from '../../apps/keymaster-client/src/oobCodec.mjs';
import { readFileSync } from 'fs';

// Non-ASCII is where a byte-oriented btoa and a Buffer-based encoder are most
// likely to disagree, so every case carries some.
const GOALS = [undefined, 'pay me', 'naïve — 主题 🎉'];

describe('demo wallet out-of-band codec', () => {
    it('builds the same invitation as the library', () => {
        for (const goal of GOALS) {
            const body = goal ? { goal } : {};
            expect(uiInvitation('did:cid:alice', body)).toStrictEqual(libInvitation('did:cid:alice', body));
        }
    });

    it('encodes byte-for-byte identically to the library', () => {
        for (const goal of GOALS) {
            const invitation = libInvitation('did:cid:alice', goal ? { goal } : {});
            expect(uiEncode(invitation)).toBe(libEncode(invitation));
        }
    });

    it('decodes what the library encoded, and the reverse', () => {
        for (const goal of GOALS) {
            const invitation = libInvitation('did:cid:alice', goal ? { goal } : {});
            expect(uiDecode(libEncode(invitation))).toStrictEqual(invitation);
            expect(libDecode(uiEncode(invitation))).toStrictEqual(invitation);
        }
    });

    it('reads a bare _oob value as well as a full URL', () => {
        const invitation = libInvitation('did:cid:alice');
        const bare = uiEncode(invitation).split('_oob=')[1];
        expect(uiDecode(bare)).toStrictEqual(invitation);
    });

    // gatekeeper-client and keymaster-client keep byte-identical sources
    // (AGENTS.md), and only one of the two copies is exercised above.
    it('is identical in both demo wallets', () => {
        const keymasterClient = readFileSync('apps/keymaster-client/src/oobCodec.mjs', 'utf-8');
        const gatekeeperClient = readFileSync('apps/gatekeeper-client/src/oobCodec.mjs', 'utf-8');
        expect(gatekeeperClient).toBe(keymasterClient);
    });
});

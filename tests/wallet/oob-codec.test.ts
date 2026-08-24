// The demo wallets cannot import @didcid/keymaster -- the server-wallet demo
// depends only on the thin client package -- so packages/keymaster-ui carries
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
} from '../../packages/keymaster-ui/src/oobCodec.mjs';
import { existsSync } from 'fs';

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

    // This used to assert the two demo wallets' copies were byte-identical.
    // They now share one, so the stronger guarantee is that neither grows a
    // local copy back -- a re-added file would be exercised by nothing and free
    // to drift, which is what the old assertion existed to prevent (#99).
    it('exists once, with no app-local copies', () => {
        const local = ['apps/keymaster-client/src/oobCodec.mjs', 'apps/gatekeeper-client/src/oobCodec.mjs']
            .filter(path => existsSync(path));

        expect(local).toStrictEqual([]);
    });
});

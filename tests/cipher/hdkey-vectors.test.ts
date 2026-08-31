import CipherNode from '../../packages/cipher/src/cipher-node.js';

// Known-answer tests for HD key derivation, pinned to fixed strings rather than
// compared against another implementation, so they hold whichever library
// performs the derivation.
//
// Every DID and wallet is derived through this path, so a change here does not
// mean a test needs updating -- it means existing keys no longer derive, and
// every wallet in the world built on this software is holding a different key
// than it did before.
//
// The mnemonic is the canonical BIP-39 test phrase; its master key is the
// published value for that phrase with an empty passphrase.

const cipher = new CipherNode();

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const MASTER_XPRV = 'xprv9s21ZrQH143K3GJpoapnV8SFfukcVBSfeCficPSGfubmSFDxo1kuHnLisriDvSnRRuL2Qrg5ggqHKNVpxR86QEC8w35uxmGoggxtQTPvfUu';
const MASTER_XPUB = 'xpub661MyMwAqRbcFkPHucMnrGNzDwb6teAX1RbKQmqtEF8kK3Z7LZ59qafCjB9eCRLiTVG3uxBxgKvRgbubRhqSKXnGGb1aoaqLrpMBDrVxga8';

// Real derivation paths: BIP-44 for bitcoin and ethereum, plus a hardened chain.
const PATHS = [
    {
        path: "m/0'",
        xprv: 'xprv9ukW2Usuz4v7Yd2EC4vNXaMckdsEdgBA9n7MQbqMJbW9FuHDWWjDwzEM2h6XmFnrzX7JVmfcNWMEVoRauU6hQpbokqPPNTbdycW9fHSPYyF',
        xpub: 'xpub68jrRzQopSUQm76hJ6TNtiJMJfhj38u1X12xCzExrw388hcN443UVnYpswdUkV7vPJ3KayiCdp3Q5E23s4wvkucohVTh7eSstJdBFyn2DMx',
        privateKey: 'c08cf331996482c06db3d259ff99be4bf7083824d53185e33191ee7ceb2bf96f',
    },
    {
        path: "m/44'/0'/0'/0/0",
        xprv: 'xprvA2cWYEXRrpaYZmR4Mat3aHw7ARSGFAtb5LQNfSuyQCCGVJXRNWA3zkkHZcBM4voi9TBrb9WaC65HGv5e8gZgfnjzH71WofaXT3haLw8LYqQ',
        xpub: 'xpub6Fbrwk4KhC8qnFVXTcR3wRsqiTGkedcSSZKyTqKaxXjFN6rZv3UJYZ4mQtjNYY3gCa181iCHSBWyWst2PFiXBKgLpFVSdcyLbHyAahin8pd',
        privateKey: 'e284129cc0922579a535bbf4d1a3b25773090d28c909bc0fed73b5e0222cc372',
    },
    {
        path: "m/44'/60'/0'/0/0",
        xprv: 'xprvA46yrWykFh3LjMHn1eqk7A8WNBt7JzJqEeBX1RNz2bx9Ditu6peK7MJWR8tfXUqPjWNuL7LwLvphdgkWShNpYXiJBuvi9agxJUWiHGHtoNk',
        xpub: 'xpub6H6LG2We64bdwqNF7gNkUJ5EvDibiT2gbs77oonbawV86XE3eMxZf9czGQ9CPdSzsdsHLnLEjiJJEDnFMAyLrWATesaVbTYeggBXMHaFKLg',
        privateKey: '1ab42cc412b618bdea3a599e3c9bae199ebf030895b039e9db1e30dafb12b727',
    },
    {
        path: "m/0'/1/2'",
        xprv: 'xprv9xy57X35Jq7oe94t1YYmD35hqF48VXyzqrMrnSzyjMKS4KSXykYHq8LJjiscfjy3nZc1dAbGjt41HXBcuE6Eju7Fp5QvQvijE7gCftVgST7',
        xpub: 'xpub6BxRX2Zy9Cg6rd9M7a5maB2SPGtctzhrD5HTaqQbHgrQw7mgXHrYNvenb253xoqr2ce64Lwhhfyjd9DuP2AUsE1AmQN9Sy4cTv2ZPypYvWB',
        privateKey: '3bbd5e864645a9143d12deb78e0810886b891ee4a51195b34ab9c93b02444ca9',
    },
];

describe('HD key derivation', () => {
    it('derives the published master key for the canonical mnemonic', () => {
        const master = cipher.generateHDKey(MNEMONIC);

        expect(master.privateExtendedKey).toBe(MASTER_XPRV);
        expect(master.publicExtendedKey).toBe(MASTER_XPUB);
    });

    it.each(PATHS)('derives $path', ({ path, xprv, xpub, privateKey }) => {
        const derived = cipher.generateHDKey(MNEMONIC).derive(path);

        expect(derived.privateExtendedKey).toBe(xprv);
        expect(derived.publicExtendedKey).toBe(xpub);
        expect(Buffer.from(derived.privateKey!).toString('hex')).toBe(privateKey);
    });

    it('round-trips through the JSON form wallets persist', () => {
        const json = cipher.generateHDKey(MNEMONIC).toJSON();

        expect(json).toStrictEqual({ xpriv: MASTER_XPRV, xpub: MASTER_XPUB });

        const restored = cipher.generateHDKeyJSON(json);

        expect(restored.privateExtendedKey).toBe(MASTER_XPRV);
        expect(restored.publicExtendedKey).toBe(MASTER_XPUB);
    });

    it('derives the same keys from a restored key as from the mnemonic', () => {
        // Restoring from JSON and deriving must match deriving directly, since a
        // loaded wallet takes the first path and a fresh one takes the second.
        const restored = cipher.generateHDKeyJSON(cipher.generateHDKey(MNEMONIC).toJSON());

        for (const { path, xprv } of PATHS) {
            expect(restored.derive(path).privateExtendedKey).toBe(xprv);
        }
    });
});

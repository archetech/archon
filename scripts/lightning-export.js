#!/usr/bin/env node

// Exports Lightning wallet keys (walletId, adminKey, invoiceKey) from the keymaster wallet.
//
// Usage:
//   ARCHON_PASSPHRASE=... node scripts/lightning-export.js [wallet-path]
//
// Environment:
//   ARCHON_PASSPHRASE   — Required. Wallet encryption passphrase.
//   ARCHON_WALLET_PATH  — Wallet file path (default: ./wallet.json)
//   ARCHON_WALLET_TYPE  — "json" (default) or "sqlite"

import path from 'path';
import Keymaster from '@didcid/keymaster';
import CipherNode from '@didcid/cipher/node';
import WalletJson from '@didcid/keymaster/wallet/json';
import WalletSQLite from '@didcid/keymaster/wallet/sqlite';

const walletPath = process.argv[2] || process.env.ARCHON_WALLET_PATH || './wallet.json';
const walletType = process.env.ARCHON_WALLET_TYPE || 'json';
const passphrase = process.env.ARCHON_PASSPHRASE;

if (!passphrase) {
    console.error('Error: ARCHON_PASSPHRASE environment variable is required');
    process.exit(1);
}

// Stub gatekeeper — only wallet access is needed
const gatekeeper = new Proxy({}, {
    get: () => () => { throw new Error('Not available in export mode'); }
});

try {
    let wallet;
    if (walletType === 'sqlite') {
        wallet = await WalletSQLite.create(walletPath);
    } else {
        const walletDir = path.dirname(walletPath);
        const walletFile = path.basename(walletPath);
        wallet = new WalletJson(walletFile, walletDir);
    }

    const cipher = new CipherNode();
    const keymaster = new Keymaster({ gatekeeper, wallet, cipher, passphrase });

    const walletData = await keymaster.loadWallet();

    const currentName = walletData.current;
    if (!currentName) {
        console.error('Error: No current identity set in wallet');
        process.exit(1);
    }

    const idInfo = walletData.ids[currentName];
    if (!idInfo || !idInfo.lightning) {
        console.error(`No Lightning wallet found for current identity: ${currentName}`);
        process.exit(1);
    }

    console.log(JSON.stringify(idInfo.lightning, null, 2));
} catch (error) {
    console.error('Error:', error.message || error);
    process.exit(1);
}

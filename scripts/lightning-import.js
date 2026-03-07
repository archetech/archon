#!/usr/bin/env node

// Imports Lightning wallet keys into the current identity from stdin or a file.
// Reads the JSON format produced by lightning-export.js.
//
// Usage:
//   ARCHON_PASSPHRASE=... node scripts/lightning-export.js | node scripts/lightning-import.js [wallet-path]
//   ARCHON_PASSPHRASE=... node scripts/lightning-import.js [wallet-path] < lightning-keys.json
//
// Environment:
//   ARCHON_PASSPHRASE   — Required. Wallet encryption passphrase.
//   ARCHON_WALLET_PATH  — Wallet file path (default: ./wallet.json)
//   ARCHON_WALLET_TYPE  — "json" (default) or "sqlite"

import path from 'path';
import fs from 'fs';
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

// Read JSON from stdin
const input = fs.readFileSync(0, 'utf-8').trim();
if (!input) {
    console.error('Error: No input received on stdin');
    process.exit(1);
}

let lightning;
try {
    lightning = JSON.parse(input);
} catch {
    console.error('Error: Invalid JSON on stdin');
    process.exit(1);
}

// Validate structure: { "url": { walletId, adminKey, invoiceKey }, ... }
for (const [url, config] of Object.entries(lightning)) {
    if (!config.walletId || !config.adminKey || !config.invoiceKey) {
        console.error(`Error: Invalid Lightning config for ${url} — missing walletId, adminKey, or invoiceKey`);
        process.exit(1);
    }
}

// Stub gatekeeper — only wallet access is needed
const gatekeeper = new Proxy({}, {
    get: () => () => { throw new Error('Not available in import mode'); }
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
    if (!idInfo) {
        console.error(`Error: Identity not found: ${currentName}`);
        process.exit(1);
    }

    idInfo.lightning = lightning;
    await keymaster.saveWallet(walletData);

    const urls = Object.keys(lightning);
    console.error(`Imported Lightning wallet keys for ${currentName} (${urls.join(', ')})`);
} catch (error) {
    console.error('Error:', error.message || error);
    process.exit(1);
}

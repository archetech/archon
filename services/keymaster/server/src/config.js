import dotenv from 'dotenv';

dotenv.config();

const config = {
    gatekeeperURL: process.env.ARCHON_GATEKEEPER_URL || 'http://localhost:4224',
    keymasterPort: process.env.ARCHON_KEYMASTER_PORT ? parseInt(process.env.ARCHON_KEYMASTER_PORT) : 4226,
    bindAddress: process.env.ARCHON_BIND_ADDRESS || '0.0.0.0',
    nodeID: process.env.ARCHON_NODE_ID || '',
    db: process.env.ARCHON_KEYMASTER_DB || 'json',
    // One secret under one name: the CLIs, the lightning scripts and the MCP
    // server read the same ARCHON_PASSPHRASE. ARCHON_ENCRYPTED_PASSPHRASE is
    // its older name, read second so a deployment carrying only that one
    // starts unchanged (#1020).
    keymasterPassphrase: process.env.ARCHON_PASSPHRASE || process.env.ARCHON_ENCRYPTED_PASSPHRASE || '',
    passphraseFromOldName: !process.env.ARCHON_PASSPHRASE && !!process.env.ARCHON_ENCRYPTED_PASSPHRASE,
    // Both names carrying different values. One of them is not the wallet's.
    passphraseShadowed: !!process.env.ARCHON_PASSPHRASE
        && !!process.env.ARCHON_ENCRYPTED_PASSPHRASE
        && process.env.ARCHON_PASSPHRASE !== process.env.ARCHON_ENCRYPTED_PASSPHRASE,
    // Sign operation proofs under archon-ecdsa-jcs-2019, putting the proof
    // configuration inside the signature (#1087). Off until every node accepts
    // the form: one that has not upgraded refuses the operation outright.
    boundOperationProofs: process.env.ARCHON_BOUND_OPERATION_PROOFS === 'true',
    walletCache: process.env.ARCHON_WALLET_CACHE ? process.env.ARCHON_WALLET_CACHE === 'true' : false,
    defaultRegistry: process.env.ARCHON_DEFAULT_REGISTRY,
    uploadLimit: process.env.ARCHON_KEYMASTER_UPLOAD_LIMIT || '10mb',
    adminApiKey: process.env.ARCHON_ADMIN_API_KEY || '',
};

export default config;

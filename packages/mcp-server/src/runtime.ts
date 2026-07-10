import path from 'path';
import CipherNode from '@didcid/cipher/node';
import DrawbridgeClient from '@didcid/clients/drawbridge';
import Keymaster from '@didcid/keymaster';
import WalletJson from '@didcid/keymaster/wallet/json';
import WalletSQLite from '@didcid/keymaster/wallet/sqlite';
import { McpServerConfig, walletLocation } from './config.js';

export interface ArchonRuntime {
    node: DrawbridgeClient;
    keymaster?: Keymaster;
}

export async function createWallet(config: McpServerConfig) {
    const { directory, file } = walletLocation(config.walletPath);

    if (config.walletType === 'sqlite') {
        return WalletSQLite.create(file, directory);
    }

    return new WalletJson(file, directory);
}

export async function createArchonRuntime(config: McpServerConfig): Promise<ArchonRuntime> {
    const node = new DrawbridgeClient();
    await node.connect({
        url: config.nodeUrl,
    });

    if (!config.passphrase) {
        return { node };
    }

    const wallet = await createWallet({
        ...config,
        walletPath: path.normalize(config.walletPath),
    });
    const cipher = new CipherNode();
    const keymaster = new Keymaster({
        gatekeeper: node,
        wallet,
        cipher,
        defaultRegistry: config.defaultRegistry,
        passphrase: config.passphrase,
    });

    return { node, keymaster };
}

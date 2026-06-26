import { createArchonRuntime, createWallet, loadConfig, walletLocation } from '@didcid/mcp-server';
import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('mcp server config', () => {
    it('uses Keymaster CLI compatible defaults', () => {
        const config = loadConfig({});

        expect(config).toStrictEqual({
            nodeUrl: 'https://archon.technology',
            walletType: 'json',
            walletPath: './wallet.json',
            passphrase: undefined,
            defaultRegistry: undefined,
            readOnly: false,
        });
    });

    it('uses ARCHON_NODE_URL before legacy ARCHON_GATEKEEPER_URL', () => {
        const config = loadConfig({
            ARCHON_NODE_URL: 'http://node.example',
            ARCHON_GATEKEEPER_URL: 'http://gatekeeper.example',
        });

        expect(config.nodeUrl).toBe('http://node.example');
    });

    it('falls back to ARCHON_GATEKEEPER_URL when ARCHON_NODE_URL is unset', () => {
        const config = loadConfig({
            ARCHON_GATEKEEPER_URL: 'http://gatekeeper.example',
        });

        expect(config.nodeUrl).toBe('http://gatekeeper.example');
    });

    it('does not use ARCHON_KEYMASTER_URL', () => {
        const config = loadConfig({
            ARCHON_KEYMASTER_URL: 'http://keymaster.example',
        });

        expect(config.nodeUrl).toBe('https://archon.technology');
        expect(config).not.toHaveProperty('keymasterUrl');
    });

    it('parses wallet and read-only settings', () => {
        const config = loadConfig({
            ARCHON_WALLET_TYPE: 'sqlite',
            ARCHON_WALLET_PATH: '/tmp/archon/wallet.db',
            ARCHON_PASSPHRASE: 'secret',
            ARCHON_DEFAULT_REGISTRY: 'BTC:mainnet',
            ARCHON_MCP_READ_ONLY: 'true',
        });

        expect(config.walletType).toBe('sqlite');
        expect(config.walletPath).toBe('/tmp/archon/wallet.db');
        expect(config.passphrase).toBe('secret');
        expect(config.defaultRegistry).toBe('BTC:mainnet');
        expect(config.readOnly).toBe(true);
        expect(walletLocation(config.walletPath)).toStrictEqual({
            directory: '/tmp/archon',
            file: 'wallet.db',
        });
    });

    it('rejects unsupported wallet types', () => {
        expect(() => loadConfig({ ARCHON_WALLET_TYPE: 'mongo' })).toThrow('Unsupported ARCHON_WALLET_TYPE');
    });

    it('creates sqlite wallets at ARCHON_WALLET_PATH instead of under default data folder', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'archon-mcp-wallet-'));
        const walletPath = path.join(directory, 'wallet.db');
        const wallet = await createWallet({
            nodeUrl: 'http://localhost:4224',
            walletType: 'sqlite',
            walletPath,
            passphrase: 'secret',
            defaultRegistry: undefined,
            readOnly: false,
        }) as { disconnect?: () => Promise<void> };

        await wallet.disconnect?.();

        expect(fs.existsSync(walletPath)).toBe(true);
        expect(fs.existsSync(path.join('data', walletPath))).toBe(false);
        fs.rmSync(directory, { recursive: true, force: true });
    });

    it('creates json wallets from ARCHON_WALLET_PATH', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'archon-mcp-json-wallet-'));
        const walletPath = path.join(directory, 'wallet.json');
        const wallet = await createWallet({
            nodeUrl: 'http://localhost:4224',
            walletType: 'json',
            walletPath,
            passphrase: 'secret',
            defaultRegistry: undefined,
            readOnly: false,
        });

        await wallet.saveWallet({ version: 2, seed: {}, counter: 0, ids: {} });

        expect(fs.existsSync(walletPath)).toBe(true);
        fs.rmSync(directory, { recursive: true, force: true });
    });

    it('creates runtime without blocking startup or writing to stdout', async () => {
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        const runtime = await createArchonRuntime({
            nodeUrl: 'http://127.0.0.1:1',
            walletType: 'json',
            walletPath: './wallet.json',
            passphrase: undefined,
            defaultRegistry: undefined,
            readOnly: false,
        });

        expect(runtime.node.url).toBe('http://127.0.0.1:1');
        expect(runtime.keymaster).toBeUndefined();
        expect(logSpy).not.toHaveBeenCalled();

        logSpy.mockRestore();
    });

    it('creates runtime with a Keymaster when a passphrase is configured', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'archon-mcp-runtime-wallet-'));
        const runtime = await createArchonRuntime({
            nodeUrl: 'http://127.0.0.1:1',
            walletType: 'json',
            walletPath: path.join(directory, 'wallet.json'),
            passphrase: 'secret',
            defaultRegistry: 'hyperswarm',
            readOnly: false,
        });

        expect(runtime.node.url).toBe('http://127.0.0.1:1');
        expect(runtime.keymaster).toBeDefined();
        fs.rmSync(directory, { recursive: true, force: true });
    });
});

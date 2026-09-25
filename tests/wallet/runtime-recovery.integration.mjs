// Run against the built service: npm run test:recovery --prefix services/mediators/satoshi-wallet
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDescriptors } from '../../services/mediators/satoshi-wallet/dist/derivation.js';

const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const other = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, timeout = 40_000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        if (await check()) return;
        await delay(100);
    }
    throw new Error('Timed out waiting for wallet state');
}
async function listen(server) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return server.address().port;
}

test('running wallet recovers from Core unloads via requests and metrics, preserving descriptor refusal', { timeout: 160_000 }, async t => {
    let loaded = false;
    let loads = 0;
    let mismatch = false;
    let rpcFailure;
    const rpc = createServer(async (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.method === 'GET') {
            res.end(JSON.stringify({ mnemonic }));
            return;
        }
        let body = '';
        for await (const chunk of req) body += chunk;
        const { method, id } = JSON.parse(body);
        let result = null;
        let error = null;
        if (method === 'createwallet') error = { code: -4, message: 'Database already exists' };
        else if (method === 'loadwallet') { loaded = true; loads++; result = { name: 'test-watch' }; }
        else if (!loaded) error = { code: -18, message: 'Requested wallet does not exist or is not loaded' };
        else if (rpcFailure) error = rpcFailure;
        else if (method === 'listdescriptors') {
            const desc = buildDescriptors(mismatch ? other : mnemonic, 'signet');
            result = { descriptors: [desc.external, desc.internal].map(d => ({ desc: d, active: true, range: [0, 20], next: 0 })) };
        } else if (method === 'getwalletinfo') result = { balance: 1, unconfirmed_balance: 0 };
        else if (method === 'listunspent') result = [];
        else if (method === 'estimatesmartfee') result = { feerate: 0.00001 };
        else if (method === 'getblockcount') result = 100;
        else if (method === 'getnewaddress') result = 'tb1qtest';
        else if (method === 'getreceivedbyaddress') result = 0;
        else error = { code: -32601, message: `Unexpected method ${method}` };
        // Exercise bitcoin-core's actual HTTP/JSON-RPC error parser.
        res.statusCode = error ? 500 : 200;
        res.end(JSON.stringify({ result, error, id }));
    });
    const rpcPort = await listen(rpc);
    const reserve = createServer();
    const apiPort = await listen(reserve);
    await new Promise(resolve => reserve.close(resolve));
    const directory = await mkdtemp(join(tmpdir(), 'wallet-recovery-'));
    const child = spawn(process.execPath, [fileURLToPath(new URL('../../services/mediators/satoshi-wallet/dist/wallet-api.js', import.meta.url))], {
        cwd: directory,
        env: {
            PATH: process.env.PATH, NODE_ENV: 'test', LOG_LEVEL: 'silent',
            ARCHON_WALLET_PORT: String(apiPort), ARCHON_WALLET_METRICS_PORT: '0',
            ARCHON_KEYMASTER_URL: `http://127.0.0.1:${rpcPort}`, ARCHON_ADMIN_API_KEY: 'test-key',
            ARCHON_WALLET_BACKEND: 'core', ARCHON_WALLET_NETWORK: 'signet', ARCHON_WALLET_NAME: 'test-watch',
            ARCHON_WALLET_BTC_HOST: '127.0.0.1', ARCHON_WALLET_BTC_PORT: String(rpcPort),
            ARCHON_WALLET_BTC_USER: 'test', ARCHON_WALLET_BTC_PASS: 'test',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) {
            const exit = once(child, 'exit');
            child.kill('SIGTERM');
            await exit;
        }
        rpc.closeAllConnections();
        await new Promise(resolve => rpc.close(resolve));
        await rm(directory, { recursive: true, force: true });
    });
    const api = (route, method = 'GET') => fetch(`http://127.0.0.1:${apiPort}/api/v1/wallet/${route}`, {
        method, headers: { 'X-Archon-Admin-Key': 'test-key' },
    });
    await waitFor(async () => {
        assert.equal(child.exitCode, null, output);
        try { return (await api('balance')).status === 200; } catch { return false; }
    }, 10_000);
    assert.equal(loads, 1);
    assert.equal((await (await api('info')).json()).ready, true);
    loaded = false;
    // Info alone must trigger recovery, before balance/UTXO requests or the
    // next metrics tick can mask a swallowed RPC error.
    assert.equal((await api('info')).status, 503);
    assert.equal((await api('address')).status, 503);
    const failed = await Promise.all([api('balance'), api('balance'), api('utxos')]);
    assert.deepEqual(failed.map(r => r.status), [503, 503, 503]);
    assert.equal((await api('address')).status, 503);
    await waitFor(() => loads === 2);
    await waitFor(async () => (await api('address')).status === 200);
    console.log('request-triggered recovery passed');

    rpcFailure = { code: -6, message: 'ordinary RPC failure' };
    assert.equal((await api('balance')).status, 500);
    const unavailable = await api('info');
    assert.equal(unavailable.status, 200);
    assert.equal((await unavailable.json()).ready, false);
    rpcFailure = undefined;
    loaded = false;
    // No wallet API requests: the existing 60-second collector must detect it.
    await waitFor(() => loads === 3, 95_000);
    assert.equal((await api('balance')).status, 200);
    console.log('metrics-triggered recovery passed');

    loaded = false;
    mismatch = true;
    assert.equal((await api('balance')).status, 503);
    await waitFor(() => loads === 4);
    await waitFor(async () => (await (await api('address')).json()).error?.includes('different seed'));
    assert.equal((await api('address')).status, 503);
    mismatch = false;
    assert.equal((await api('setup', 'POST')).status, 200);
    assert.equal((await api('address')).status, 200);
    console.log('descriptor refusal and explicit repair passed');
});

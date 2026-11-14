// Records the payment the video shows, from two React wallets on the regtest stack.
//
//   node capture.mjs setup   # create Alice and Bob, publish their DIDComm endpoints,
//                            # join the node's mint, fund Alice with 21,000 sats
//   node capture.mjs send    # Alice sends 2,100 sats to Bob's DID → screens/a*.png, b0–b3
//   node capture.mjs claim   # Bob claims, Alice settles → the rest, and data.json
//
// Each wallet is a browser profile of its own under profiles/, so the two are separate
// wallets that keep their state between the three steps. See README.md for what has to
// be running.
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const WALLET = process.env.WALLET_URL || 'http://127.0.0.1:4228';
const AMOUNT = '2100', FUNDING = '21000', MEMO = 'Dinner on Friday';
if (!process.env.CHROME) throw new Error('set CHROME to a Chrome or chrome-headless-shell binary');

// The stack publishes no ports, so the wallets reach its Drawbridge by container address.
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' });
const address = container => docker('inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', container).trim();
const NODE = `http://${address('cashu-regtest-drawbridge-1')}:4222`;
const cli = (...args) => docker('exec', '-e', 'ARCHON_KEYMASTER_URL=http://keymaster-ts:4226', 'cashu-regtest-cli-1', 'node', ...args);

async function open(who) {
    const context = await chromium.launchPersistentContext(path.join(dir, 'profiles', who), {
        executablePath: process.env.CHROME, viewport: { width: 430, height: 900 }, deviceScaleFactor: 2,
    });
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const page = context.pages()[0] ?? await context.newPage();
    await page.addInitScript(node => {
        localStorage.setItem('gatekeeperUrl', node);
        localStorage.setItem('themeMode', 'dark');
    }, NODE);
    await page.goto(WALLET);
    await page.waitForTimeout(3500);
    const passphrase = page.locator('input[type=password]');
    if (await passphrase.count()) {
        for (let i = 0; i < await passphrase.count(); i++) {
            await passphrase.nth(i).fill(`${who}-passphrase`);
        }
        await page.getByRole('button', { name: /submit/i }).click();
        await page.waitForTimeout(6000);
    }
    return { context, page };
}

const text = page => page.locator('body').innerText();
const balance = async page => (await text(page)).match(/Balance: ([\d,]+) sats/)?.[1];
const field = (page, label) => page.locator(`label:text-is("${label}")`).locator('xpath=following-sibling::div//input');
async function menu(page, item) {
    await page.getByRole('button', { name: 'More' }).click();
    await page.waitForTimeout(700);
    await page.getByText(item, { exact: true }).last().click();
    await page.waitForTimeout(2500);
}
async function tab(page, name) {
    await page.getByRole('tab', { name, exact: true }).click();
    await page.waitForTimeout(1800);
}
async function snap(page, file) {
    await page.evaluate(() => document.activeElement?.blur());
    await page.waitForTimeout(350);
    await page.screenshot({ path: path.join(dir, 'screens', `${file}.png`) });
}

async function setup(who, sats) {
    const { context, page } = await open(who);
    if (/No identity selected/.test(await text(page))) {
        await page.getByRole('button', { name: 'Create ID' }).first().click();
        await page.getByRole('dialog').locator('input[type=text]').fill(who[0].toUpperCase() + who.slice(1));
        await page.getByRole('combobox').click();
        await page.getByRole('option', { name: 'local' }).click();
        await page.getByRole('button', { name: 'Create', exact: true }).click();
        await page.waitForTimeout(6000);
    }
    await menu(page, 'DIDComm');
    await tab(page, 'Endpoint');
    if (/No DIDComm endpoint published/.test(await text(page))) {
        await page.getByRole('button', { name: 'Publish' }).click();
        await page.getByText('Key agreement').waitFor({ timeout: 60000 });
        await page.waitForTimeout(1500);
    }
    await menu(page, 'Cashu');
    if (/No mints yet/.test(await text(page))) {
        await page.getByRole('button', { name: "Use This Node's Mint" }).click();
        await page.getByText('Balance:').waitFor({ timeout: 60000 });
        await page.waitForTimeout(1500);
    }
    if (sats && await balance(page) === '0') {
        await tab(page, 'Mint');
        await field(page, 'Amount (sats)').fill(sats);
        await page.getByRole('button', { name: 'Create Invoice' }).click();
        await page.waitForTimeout(6000);
        const invoice = (await page.content()).match(/lnbcrt[0-9a-z]+/)?.[0];
        if (!invoice) throw new Error('the wallet showed no invoice');
        docker('exec', 'cashu-regtest-cln-user-1', 'lightning-cli', '--rpc-file=/data/lightning/regtest/regtest/lightning-rpc', 'pay', invoice);
        // In the same session: the open quote is not there after the wallet is reopened.
        await page.getByRole('button', { name: 'Claim Once Paid' }).click();
        await page.getByRole('button', { name: 'Claim Once Paid' }).waitFor({ state: 'detached', timeout: 60000 });
        await tab(page, 'Wallet');
        await page.getByText(`Balance: ${Number(sats).toLocaleString('en-US')} sats`).waitFor({ timeout: 60000 });
    }
    console.log(`${who}: ${await balance(page)} sats`);
    await context.close();
}

async function send() {
    const A = await open('alice'), B = await open('bob');
    const a = A.page, b = B.page;
    const seen = {};

    // Bob's DID, from his own wallet's copy button.
    await b.locator('header button, [aria-label*="opy"]').last().click();
    seen.bob = await b.evaluate(() => navigator.clipboard.readText());
    if (!/^did:cid:/.test(seen.bob)) throw new Error(`expected Bob's DID on the clipboard, got ${seen.bob}`);
    await menu(b, 'DIDComm'); await tab(b, 'Endpoint'); await snap(b, 'b0-endpoint');
    await menu(b, 'Cashu'); await snap(b, 'b1-balance');

    await menu(a, 'Cashu'); await snap(a, 'a1-balance');
    await tab(a, 'DIDComm'); await snap(a, 'a2-form');
    await field(a, 'Recipient').fill(seen.bob); await a.keyboard.press('Escape'); await snap(a, 'a3-to');
    await field(a, 'Amount (sats)').fill(AMOUNT); await snap(a, 'a4-amount');
    await field(a, 'Memo (optional)').fill(MEMO);
    await field(a, 'Hours until you can reclaim it (optional)').fill('24'); await snap(a, 'a5-filled');
    await a.getByRole('button', { name: 'Send', exact: true }).click();
    await a.getByText('Locked to the recipient').waitFor({ timeout: 90000 });
    await snap(a, 'a6-sent');
    await tab(a, 'Outstanding'); await snap(a, 'a7-outstanding');

    // Bob: the raw DIDComm inbox, then the Cashu view of the same message.
    await menu(b, 'DIDComm');
    await b.getByRole('button', { name: 'Refresh' }).click();
    await b.getByText('Authenticated').waitFor({ timeout: 60000 });
    await snap(b, 'b2-inbox');
    seen.inbox = await text(b);
    seen.token = (await b.content()).match(/cashuB[0-9A-Za-z_-]{60,}/)?.[0];
    await menu(b, 'Cashu'); await tab(b, 'DIDComm');
    await b.getByText(MEMO).waitFor({ timeout: 60000 });
    await snap(b, 'b3-incoming');

    writeFileSync(path.join(dir, 'screens', 'capture.json'), JSON.stringify(seen, null, 4));
    await A.context.close(); await B.context.close();
    console.log(`sent ${AMOUNT} sats to ${seen.bob}`);
}

async function claim() {
    const seen = JSON.parse(readFileSync(path.join(dir, 'screens', 'capture.json'), 'utf8'));
    const A = await open('alice'), B = await open('bob');
    const a = A.page, b = B.page;
    await menu(b, 'Cashu'); await tab(b, 'DIDComm');
    await b.getByRole('button', { name: 'Claim All' }).click();
    await b.getByText('No token messages waiting').waitFor({ timeout: 90000 });
    await tab(b, 'Wallet'); await snap(b, 'b4-balance');
    await menu(a, 'Cashu');
    await a.getByRole('button', { name: 'Check' }).click();
    await a.waitForTimeout(5000);
    await snap(a, 'a9-settled');
    const balances = { alice: await balance(a), bob: await balance(b) };
    await A.context.close(); await B.context.close();

    // What the panels quote. The lock is read out of the token Alice sent, and Bob's
    // document is resolved again here, so the two can be seen to agree.
    const decode = "import('@cashu/cashu-ts').then(m => console.log(JSON.stringify(JSON.parse(m.getTokenMetadata(process.argv[1]).incompleteProofs[0].secret)[1])))";
    const lock = JSON.parse(cli('-e', decode, seen.token));
    const document = JSON.parse(cli('scripts/archon-cli.js', 'resolve-did', seen.bob).replace(/^[^{]*/, '')).didDocument;
    const tags = Object.fromEntries(lock.tags);
    const data = {
        alice: seen.inbox.match(/From: (did:cid:[a-z0-9]+)/)[1],
        bob: seen.bob,
        keyX: document.verificationMethod[0].publicKeyJwk.x,
        kaX: document.verificationMethod[1].publicKeyJwk.x,
        endpoint: document.service[0].serviceEndpoint.uri,
        lock: lock.data, nonce: lock.nonce, locktime: tags.locktime, refund: tags.refund,
        type: seen.inbox.match(/https:\/\/archetech\.com\/didcomm\/cashu\/[\d.]+\/token/)[0],
        memo: MEMO, token: seen.token.slice(0, 30),
        before: { alice: '21,000', bob: '0' }, after: balances,
    };
    // The key the ecash is locked to is the compressed form of Bob's #key-1.
    const x = Buffer.from(data.keyX, 'base64url').toString('hex');
    if (data.lock.slice(2) !== x) throw new Error(`the token is locked to ${data.lock}, not to Bob's #key-1 (${x})`);
    writeFileSync(path.join(dir, 'data.json'), JSON.stringify(data, null, 4) + '\n');
    console.log(`Alice ${balances.alice} sats, Bob ${balances.bob} sats`);
}

mkdirSync(path.join(dir, 'screens'), { recursive: true });
const step = process.argv[2];
if (step === 'setup') {
    await setup('alice', FUNDING);
    await setup('bob');
} else if (step === 'send') {
    await send();
} else if (step === 'claim') {
    await claim();
} else {
    throw new Error('usage: node capture.mjs setup | send | claim');
}

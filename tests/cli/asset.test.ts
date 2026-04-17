import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { archon, resetAll, freshWalletWithId, parseDid, dockerExec } from './helpers';

const exec = promisify(execFile);

let tempDir: string;
let emptyAssetDid: string;
let jsonAssetDid: string;
let imageAssetDid: string;
let fileAssetDid: string;

beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'archon-cli-asset-'));

    // Ensure /app/share is writable by the container user (uid may differ from host)
    await exec('docker', ['compose', 'exec', '-u', '0', '-T', 'cli', 'chown', '1000:1000', '/app/share']);

    await freshWalletWithId('qa-asset');

    // Create an empty asset
    const emptyOutput = await archon('create-asset', '-r', 'local');
    emptyAssetDid = parseDid(emptyOutput);

    // Create a JSON test file and copy into the container
    const jsonData = { name: 'test-asset', version: 1 };
    const jsonFile = join(tempDir, 'test-asset.json');
    writeFileSync(jsonFile, JSON.stringify(jsonData));
    await exec('docker', ['compose', 'cp', jsonFile, 'cli:/app/share/test-asset.json']);

    const jsonOutput = await archon('create-asset-json', '-r', 'local', 'share/test-asset.json');
    jsonAssetDid = parseDid(jsonOutput);

    // Create a small PNG test image (1x1 pixel) and copy into the container
    const pngHeader = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1
        0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, // 8-bit RGB
        0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, // IDAT chunk
        0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
        0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc,
        0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, // IEND chunk
        0x44, 0xae, 0x42, 0x60, 0x82,
    ]);
    const imgFile = join(tempDir, 'test-image.png');
    writeFileSync(imgFile, pngHeader);
    await exec('docker', ['compose', 'cp', imgFile, 'cli:/app/share/test-image.png']);

    const imageOutput = await archon('create-asset-image', '-r', 'local', 'share/test-image.png');
    imageAssetDid = parseDid(imageOutput);

    // Create a plain text file asset and copy into the container
    const txtFile = join(tempDir, 'test-file.txt');
    writeFileSync(txtFile, 'hello archon');
    await exec('docker', ['compose', 'cp', txtFile, 'cli:/app/share/test-file.txt']);

    const fileOutput = await archon('create-asset-file', '-r', 'local', 'share/test-file.txt');
    fileAssetDid = parseDid(fileOutput);
}, 120000);

afterAll(async () => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try {
        await dockerExec('cli', 'rm', '-f',
            '/app/share/test-asset.json',
            '/app/share/test-image.png',
            '/app/share/test-file.txt',
            '/app/share/updated-asset.json',
            '/app/share/updated-image.png',
            '/app/share/updated-file.txt',
            '/app/share/out-asset.json',
            '/app/share/out-image.png',
            '/app/share/out-file.txt',
        );
    } catch { /* ignore */ }
    await resetAll();
});

describe('asset creation', () => {
    test('create-asset returns a DID', () => {
        expect(emptyAssetDid).toMatch(/^did:cid:[a-zA-Z0-9]+$/);
    });

    test('create-asset-json returns a DID', () => {
        expect(jsonAssetDid).toMatch(/^did:cid:[a-zA-Z0-9]+$/);
    });

    test('create-asset-image returns a DID', () => {
        expect(imageAssetDid).toMatch(/^did:cid:[a-zA-Z0-9]+$/);
    });

    test('create-asset-file returns a DID', () => {
        expect(fileAssetDid).toMatch(/^did:cid:[a-zA-Z0-9]+$/);
    });
});

describe('asset retrieval', () => {
    test('get-asset returns the empty asset', async () => {
        const output = await archon('get-asset', emptyAssetDid);
        const asset = JSON.parse(output);
        expect(asset).toEqual({});
    });

    test('get-asset returns the JSON asset data', async () => {
        const output = await archon('get-asset', jsonAssetDid);
        const asset = JSON.parse(output);
        expect(asset).toHaveProperty('name', 'test-asset');
        expect(asset).toHaveProperty('version', 1);
    });

    test('get-asset-json saves JSON to a file', async () => {
        const output = await archon('get-asset-json', jsonAssetDid, 'share/out-asset.json');
        expect(output).toContain('share/out-asset.json');

        // Verify the file contents inside the container
        const contents = await dockerExec('cli', 'cat', '/app/share/out-asset.json');
        const data = JSON.parse(contents);
        expect(data).toHaveProperty('name', 'test-asset');
    });

    test('get-asset-image saves image to a file', async () => {
        const output = await archon('get-asset-image', imageAssetDid, 'share/out-image.png');
        expect(output).toContain('share/out-image.png');

        const stat = await dockerExec('cli', 'stat', '--format=%s', '/app/share/out-image.png');
        expect(Number(stat)).toBeGreaterThan(0);
    });

    test('get-asset-file saves file to disk', async () => {
        const output = await archon('get-asset-file', fileAssetDid, 'share/out-file.txt');
        expect(output).toContain('share/out-file.txt');

        const contents = await dockerExec('cli', 'cat', '/app/share/out-file.txt');
        expect(contents).toContain('hello archon');
    });
});

describe('asset updates', () => {
    test('update-asset-json merges data', async () => {
        const updatedData = { name: 'test-asset', version: 2, extra: true };
        const updateFile = join(tempDir, 'updated-asset.json');
        writeFileSync(updateFile, JSON.stringify(updatedData));
        await exec('docker', ['compose', 'cp', updateFile, 'cli:/app/share/updated-asset.json']);

        const output = await archon('update-asset-json', jsonAssetDid, 'share/updated-asset.json');
        expect(output).toContain('OK');

        // Verify the merge
        const getOutput = await archon('get-asset', jsonAssetDid);
        const asset = JSON.parse(getOutput);
        expect(asset).toHaveProperty('version', 2);
        expect(asset).toHaveProperty('extra', true);
    });

    test('update-asset-image replaces image', async () => {
        // Create a different small image (2x1 pixel)
        const png2 = Buffer.from([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
            0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
            0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x01,
            0x08, 0x02, 0x00, 0x00, 0x00, 0x7d, 0x99, 0x4b,
            0x2f, 0x00, 0x00, 0x00, 0x0e, 0x49, 0x44, 0x41,
            0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0xc0,
            0xc0, 0x00, 0x00, 0x00, 0x04, 0x00, 0x01, 0xd4,
            0xac, 0xc3, 0xb2, 0x00, 0x00, 0x00, 0x00, 0x49,
            0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
        ]);
        const imgFile = join(tempDir, 'updated-image.png');
        writeFileSync(imgFile, png2);
        await exec('docker', ['compose', 'cp', imgFile, 'cli:/app/share/updated-image.png']);

        const output = await archon('update-asset-image', imageAssetDid, 'share/updated-image.png');
        expect(output).toContain('OK');
    });

    test('update-asset-file replaces file', async () => {
        const txtFile = join(tempDir, 'updated-file.txt');
        writeFileSync(txtFile, 'updated archon content');
        await exec('docker', ['compose', 'cp', txtFile, 'cli:/app/share/updated-file.txt']);

        const output = await archon('update-asset-file', fileAssetDid, 'share/updated-file.txt');
        expect(output).toContain('OK');
    });
});

describe('asset properties', () => {
    test('set-property assigns a value', async () => {
        const output = await archon('set-property', emptyAssetDid, 'color', 'blue');
        expect(output).toContain('OK');
    });

    test('get-property retrieves the value', async () => {
        const output = await archon('get-property', emptyAssetDid, 'color');
        expect(output).toContain('blue');
    });

    test('set-property with JSON value', async () => {
        const output = await archon('set-property', emptyAssetDid, 'meta', '{"x":1}');
        expect(output).toContain('OK');

        const getOutput = await archon('get-property', emptyAssetDid, 'meta');
        const meta = JSON.parse(getOutput);
        expect(meta).toEqual({ x: 1 });
    });

    test('set-property with null removes the key', async () => {
        const output = await archon('set-property', emptyAssetDid, 'color');
        expect(output).toContain('OK');

        const getOutput = await archon('get-property', emptyAssetDid, 'color');
        expect(getOutput).toBe('');
    });
});

describe('list-assets', () => {
    test('list-assets includes created assets', async () => {
        const output = await archon('list-assets');
        const assets = JSON.parse(output);

        expect(Array.isArray(assets)).toBe(true);
        expect(assets).toContain(emptyAssetDid);
        expect(assets).toContain(jsonAssetDid);
        expect(assets).toContain(imageAssetDid);
        expect(assets).toContain(fileAssetDid);
    });
});

describe('clone-asset', () => {
    test('clone-asset returns a new DID', async () => {
        const output = await archon('clone-asset', '-r', 'local', jsonAssetDid);
        const cloneDid = parseDid(output);

        expect(cloneDid).toMatch(/^did:cid:[a-zA-Z0-9]+$/);
        expect(cloneDid).not.toBe(jsonAssetDid);

        // Clone should have the same data plus a 'cloned' back-reference
        const cloneData = JSON.parse(await archon('get-asset', cloneDid));
        const original = JSON.parse(await archon('get-asset', jsonAssetDid));
        expect(cloneData).toMatchObject(original);
        expect(cloneData).toHaveProperty('cloned', jsonAssetDid);
    });
});

describe('transfer-asset', () => {
    test('transfer-asset moves ownership', async () => {
        // Create a second identity to transfer to
        const secondId = await archon('create-id', '-r', 'local', 'qa-asset-receiver');
        const receiverDid = parseDid(secondId);

        // Switch back to the first ID to do the transfer
        await archon('use-id', 'qa-asset');

        // Create a fresh asset for transfer
        const newOutput = await archon('create-asset', '-r', 'local');
        const transferDid = parseDid(newOutput);

        const output = await archon('transfer-asset', transferDid, receiverDid);
        expect(output).toContain('OK');
    });
});

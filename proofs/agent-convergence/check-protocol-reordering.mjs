import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { generateAssetFixtures } from './generate-asset-fixtures.mjs';
import { generateProtocolFixtures } from './generate-protocol-fixtures.mjs';

export function reorderedProtocolVector(vector) {
    const v = structuredClone(vector), count = v.operations.length, events = v.events.length;
    v.operations.reverse(); v.ids.reverse(); v.signatureValid.reverse();
    for (const c of v.controllers) { c.operations.reverse(); c.ids.reverse(); c.signatureValid.reverse(); }
    v.events.reverse(); v.labels.reverse();
    for (const stage of v.stages) {
        stage.evidence = stage.evidence.map(i => events - i - 1);
        stage.orders = stage.orders.map(order => order.map(i => events - i - 1));
        stage.expected = stage.expected.map(i => count - i - 1);
    }
    return v;
}

export function checkProtocolReordering(vectors) {
    const original = vectors.find(v => v.mode === 'chain');
    const v = reorderedProtocolVector(original);
    assert.deepEqual(v.stages.map(s => s.expected.map(i => v.ids[i])),
        original.stages.map(s => s.expected.map(i => original.ids[i])));
    const generated = generateAssetFixtures([v]);
    const rename = code => code.replaceAll('AssetControllerFixtures', 'ReorderedAssetControllerFixtures')
        .replaceAll('AssetFixtures', 'ReorderedAssetFixtures').replaceAll('ProtocolFixtures', 'ReorderedProtocolFixtures');
    const directory = mkdtempSync(join(tmpdir(), 'archon-proof-reorder-'));
    try {
        for (const [name, code] of [['ReorderedAssetControllerFixtures', generated.controllers],
            ['ReorderedAssetFixtures', generated.assets], ['ReorderedProtocolFixtures', generateProtocolFixtures([v])]]) {
            const path = join(directory, name + '.lean');
            writeFileSync(path, rename(code));
            const result = spawnSync('lake', ['env', 'lean', '--root=' + directory, path, '-o', join(directory, name + '.olean')], {
                cwd: fileURLToPath(new URL('.', import.meta.url)), encoding: 'utf8', maxBuffer: 1024 * 1024,
                env: { ...process.env, LEAN_PATH: [directory, process.env.LEAN_PATH].filter(Boolean).join(delimiter) },
            });
            assert.ifError(result.error);
            assert.equal(result.status, 0, `${name}:\n${result.stdout}\n${result.stderr}`);
        }
    } finally { rmSync(directory, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    checkProtocolReordering(JSON.parse(readFileSync(new URL('../../tests/convergence/asset-vectors.json', import.meta.url), 'utf8')));
    console.log('Reordered signed protocol bridge checked by Lean');
}

import MemoryClient from '@didcid/ipfs/memory';
import { generateCID } from '@didcid/ipfs/utils';

describe('MemoryClient', () => {
    // The Gatekeeper mints a DID from the CID addJSON returns, and KuboClient
    // computes that CID the same way -- json codec, sha256, CIDv1. A store that
    // addressed JSON differently would hand the tests DIDs a node would never
    // produce.
    it('addresses JSON the way a node does', async () => {
        const operation = { type: 'create', created: '2026-01-01T00:00:00Z' };
        const ipfs = new MemoryClient();

        expect(await ipfs.addJSON(operation)).toBe(await generateCID(operation));
    });

    it('reads back what it stored', async () => {
        const ipfs = new MemoryClient();
        const json = { hello: 'world', nested: { list: [1, 2, 3] } };

        expect(await ipfs.getJSON(await ipfs.addJSON(json))).toStrictEqual(json);
        expect(await ipfs.getText(await ipfs.addText('some text'))).toBe('some text');
        expect(await ipfs.getData(await ipfs.addData(Buffer.from([1, 2, 3])))).toStrictEqual(Buffer.from([1, 2, 3]));
    });

    it('gives equal content one address', async () => {
        const ipfs = new MemoryClient();

        expect(await ipfs.addJSON({ a: 1 })).toBe(await ipfs.addJSON({ a: 1 }));
        expect(await ipfs.addText('x')).not.toBe(await ipfs.addText('y'));
    });

    // The Gatekeeper asks for operations it may not hold and types the answer
    // `Operation | null`, so an unknown CID is an absence, not a failure.
    it('reports an unknown CID as absent rather than throwing', async () => {
        const ipfs = new MemoryClient();

        await expect(ipfs.getJSON(await generateCID({ never: 'stored' }))).resolves.toBeNull();
    });

    it('rebuilds a stream into one block, and streams it back', async () => {
        const ipfs = new MemoryClient();
        const chunks = [Buffer.from('one '), Buffer.from('two '), Buffer.from('three')];

        async function* source() {
            for (const chunk of chunks) {
                yield chunk;
            }
        }

        const cid = await ipfs.addDataStream(source());
        expect(cid).toBe(await ipfs.addData(Buffer.concat(chunks)));

        const read = [];
        for await (const chunk of ipfs.getDataStream(cid)) {
            read.push(chunk);
        }

        expect(Buffer.concat(read).toString()).toBe('one two three');
    });

    // Suites bracket their work with these, and a store that survived stop()
    // would carry one test's content into the next.
    it('starts, stops, and forgets what it held', async () => {
        const ipfs = new MemoryClient();
        await ipfs.start();
        const cid = await ipfs.addText('gone after stop');
        await ipfs.stop();

        expect(await ipfs.getText(cid)).toBe('');
    });
});

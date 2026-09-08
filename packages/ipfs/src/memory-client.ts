import * as jsonCodec from 'multiformats/codecs/json';
import { ArchonError } from '@didcid/common/errors';
import { IPFSClient } from './types.js';
import { generateCID } from './utils.js';

export class BlockNotFoundError extends ArchonError {
    static type = 'Block not found';

    constructor(cid: string) {
        super(`${BlockNotFoundError.type}: ${cid}`);
    }
}

// An IPFSClient backed by a Map, for tests and for anything that wants content
// addressing without a node. The Gatekeeper requires an IPFSClient, so a suite
// that does not run a daemon still needs somewhere to put operations.
//
// CIDs come from generateCID, which is how KuboClient addresses JSON as well:
// both encode with the json codec and hash with sha256, so a DID minted here is
// the DID a node would mint for the same operation. Text and binary are stored
// raw, where a node would chunk them through unixfs and get a different CID --
// reproducing that would mean depending on unixfs, which is the point of not
// using it.
export default class MemoryClient implements IPFSClient {
    private blocks = new Map<string, Uint8Array>();

    // No node to run. Present because callers written against a networked
    // client bracket their work with these.
    async start(): Promise<void> {}

    async stop(): Promise<void> {
        this.blocks.clear();
    }

    // Copied in, because a CID promises its bytes do not change. addData is
    // handed the caller's Buffer, and keeping the reference would let them
    // rewrite the content behind an address already computed from it.
    // Absent content raises, because that is what a node does: KuboClient's
    // reads carry a 10s timeout and throw TimeoutError when nobody has the
    // block, and Helia's blocked on a local-only node. Answering null or empty
    // instead would let a test pass where production raises -- and the routes
    // over these methods rely on the throw to report the miss rather than
    // returning 200 with an empty body.
    private require(cid: string): Uint8Array {
        const bytes = this.blocks.get(cid);

        if (bytes === undefined) {
            throw new BlockNotFoundError(cid);
        }

        return bytes;
    }

    private async put(bytes: Uint8Array, key: any): Promise<string> {
        const cid = await generateCID(key);
        this.blocks.set(cid, Uint8Array.from(bytes));

        return cid;
    }

    async addText(text: string): Promise<string> {
        return this.put(new TextEncoder().encode(text), text);
    }

    async getText(cid: string): Promise<string> {
        return new TextDecoder().decode(this.require(cid));
    }

    async addData(data: Buffer): Promise<string> {
        return this.put(data, data);
    }

    async getData(cid: string): Promise<Buffer> {
        return Buffer.from(this.require(cid));
    }

    async addDataStream(stream: AsyncIterable<Uint8Array>): Promise<string> {
        const chunks: Uint8Array[] = [];

        for await (const chunk of stream) {
            chunks.push(chunk);
        }

        return this.addData(Buffer.concat(chunks));
    }

    // Copied out for the same reason getData copies: a consumer that writes
    // through the chunk it was yielded would edit the stored block.
    async *getDataStream(cid: string): AsyncIterable<Uint8Array> {
        yield Uint8Array.from(this.require(cid));
    }

    async addJSON(json: any): Promise<string> {
        return this.put(jsonCodec.encode(json), json);
    }

    async getJSON(cid: string): Promise<any> {
        return jsonCodec.decode(this.require(cid));
    }
}

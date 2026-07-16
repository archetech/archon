import { jest } from '@jest/globals';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerArchonResources, registerArchonTools, McpServerConfig } from '@didcid/mcp-server';

const baseConfig: McpServerConfig = {
    nodeUrl: 'http://localhost:4224',
    walletType: 'json',
    walletPath: './wallet.json',
    passphrase: 'secret',
    defaultRegistry: undefined,
    readOnly: false,
};

const FILE_DID = 'did:cid:z3v8AuahBQrJDVCNhhVQNzTbdMGmCyUM8b7WrqQKmYYqNZmMbfR';
const JSON_DID = 'did:cid:z3v8AuahBQrJDVCNhhVQNzTbdMGmCyUM8b7WrqQKmYYqNZmMbfX';

function mockKeymaster() {
    return {
        getFile: jest.fn<any>().mockResolvedValue({ filename: 'hello.txt', type: 'text/plain', data: Buffer.from('hello') }),
        resolveAsset: jest.fn<any>().mockResolvedValue({ hello: 'world' }),
    };
}

async function connect(keymaster: any) {
    const server = new McpServer({ name: 'archon-test', version: '0.0.0' });
    registerArchonResources(server as any, { node: {} as any, keymaster });

    const client = new Client({ name: 'archon-test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    return client;
}

describe('mcp server resources', () => {
    it('advertises the resources capability', async () => {
        const client = await connect(mockKeymaster());

        // This is the SHOULD that #721 left unmet: a server embedding resource blocks in
        // tool results is expected to implement the capability.
        expect(client.getServerCapabilities()?.resources).toBeDefined();
    });

    it('reads a file asset by its DID', async () => {
        const keymaster = mockKeymaster();
        const client = await connect(keymaster);

        const result: any = await client.readResource({ uri: FILE_DID });

        expect(result.contents).toStrictEqual([{
            uri: FILE_DID,
            mimeType: 'text/plain',
            blob: Buffer.from('hello').toString('base64'),
        }]);
        expect(keymaster.getFile).toHaveBeenCalledWith(FILE_DID);
        // The binary path must not pay for a second resolve.
        expect(keymaster.resolveAsset).not.toHaveBeenCalled();
    });

    it('reads a non-binary asset as its JSON data', async () => {
        const keymaster = mockKeymaster();
        keymaster.getFile.mockResolvedValue(null);
        const client = await connect(keymaster);

        const result: any = await client.readResource({ uri: JSON_DID });

        expect(result.contents).toStrictEqual([{
            uri: JSON_DID,
            mimeType: 'application/json',
            text: JSON.stringify({ hello: 'world' }),
        }]);
    });

    it('errors rather than answering with metadata when asset bytes are unavailable', async () => {
        const keymaster = mockKeymaster();
        // What getFile really returns when the gatekeeper cannot fetch the CID: the file
        // asset, minus its data. Distinct from null, which means "not a file asset".
        keymaster.getFile.mockResolvedValue({ filename: 'hello.txt', type: 'text/plain', cid: 'bafy...' });
        const client = await connect(keymaster);

        await expect(client.readResource({ uri: FILE_DID })).rejects.toThrow(/unavailable/i);
        // Must not silently degrade into a JSON read of the asset's metadata.
        expect(keymaster.resolveAsset).not.toHaveBeenCalled();
    });

    it('does not enumerate wallet assets', async () => {
        const keymaster = mockKeymaster();
        const client = await connect(keymaster);

        // Reads are by a URI the caller already holds. Listing every asset would disclose
        // the wallet's contents to any connected client, so the template opts out.
        const listed = await client.listResources();
        expect(listed.resources).toStrictEqual([]);

        const templates = await client.listResourceTemplates();
        expect(templates.resourceTemplates.map((t: any) => t.uriTemplate)).toStrictEqual(['did:cid:{id}']);
        expect(keymaster.getFile).not.toHaveBeenCalled();
        expect(keymaster.resolveAsset).not.toHaveBeenCalled();
    });

    it('rejects a URI that is not an Archon asset DID', async () => {
        const client = await connect(mockKeymaster());

        await expect(client.readResource({ uri: 'did:web:example.com' })).rejects.toThrow();
        await expect(client.readResource({ uri: 'https://example.com/secret' })).rejects.toThrow();
    });

    it('fails cleanly when the server has no wallet', async () => {
        const client = await connect(undefined);

        // Resources are wallet-backed and must fail the same way the equivalent tools do.
        await expect(client.readResource({ uri: FILE_DID })).rejects.toThrow(/ARCHON_PASSPHRASE/);
    });

    // The point of the capability: the URI archon_get_asset_file already puts in its
    // embedded resource block is now one a client can actually dereference. Registering
    // both surfaces on one server proves the two halves line up, which is exactly what
    // shipping the resource block without resources/read left unproven.
    it('makes the URI in a tool result dereferenceable', async () => {
        const keymaster = {
            lookupDID: jest.fn<any>().mockResolvedValue(FILE_DID),
            getFile: jest.fn<any>().mockResolvedValue({ filename: 'hello.txt', type: 'text/plain', data: Buffer.from('hello') }),
            resolveAsset: jest.fn<any>().mockResolvedValue({}),
        };

        const server = new McpServer({ name: 'archon-test', version: '0.0.0' });
        const runtime = { node: {} as any, keymaster };
        registerArchonTools(server as any, runtime as any, baseConfig);
        registerArchonResources(server as any, runtime as any);

        const client = new Client({ name: 'archon-test-client', version: '0.0.0' });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        await Promise.all([server.connect(st), client.connect(ct)]);

        const called: any = await client.callTool({ name: 'archon_get_asset_file', arguments: { id: 'hello-alias' } });
        const block = (called.content as any[]).find(b => b.type === 'resource');
        const uri = block.resource.uri;

        expect(uri).toBe(FILE_DID);

        // Hand the tool's own URI straight back to resources/read.
        const read: any = await client.readResource({ uri });
        expect(read.contents[0].blob).toBe(block.resource.blob);
        expect(read.contents[0].mimeType).toBe(block.resource.mimeType);
    });
});

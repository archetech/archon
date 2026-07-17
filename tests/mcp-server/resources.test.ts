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

const VAULT_DID = 'did:cid:z3v8AuahBQrJDVCNhhVQNzTbdMGmCyUM8b7WrqQKmYYqNZmMbfV';

function mockKeymaster() {
    return {
        getFile: jest.fn<any>().mockResolvedValue({ filename: 'hello.txt', type: 'text/plain', data: Buffer.from('hello') }),
        resolveAsset: jest.fn<any>().mockResolvedValue({ hello: 'world' }),
        lookupDID: jest.fn<any>(async (id: string) => (id.startsWith('did:') ? id : VAULT_DID)),
        getVaultItem: jest.fn<any>().mockResolvedValue(Buffer.from('item bytes')),
        listVaultItems: jest.fn<any>().mockResolvedValue({
            'notes.txt': { cid: 'bafy', type: 'text/plain', bytes: 10 },
            'my notes #2.txt': { cid: 'bafy2', type: 'application/json', bytes: 4 },
        }),
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
        // Order is load-bearing, not cosmetic: the SDK reads the first template whose URI
        // matches, and 'did:cid:{id}' matches greedily. If the vault-item template were
        // registered second, a 'did:cid:vault#item' read would be swallowed by the asset
        // reader as id='vault#item'.
        expect(templates.resourceTemplates.map((t: any) => t.uriTemplate)).toStrictEqual([
            'did:cid:{id}#{item}',
            'did:cid:{id}',
        ]);
        expect(keymaster.getFile).not.toHaveBeenCalled();
        expect(keymaster.resolveAsset).not.toHaveBeenCalled();
    });

    it('reads a vault item by its DID URL fragment', async () => {
        const keymaster = mockKeymaster();
        const client = await connect(keymaster);

        const result: any = await client.readResource({ uri: `${VAULT_DID}#notes.txt` });

        expect(result.contents).toStrictEqual([{
            uri: `${VAULT_DID}#notes.txt`,
            // The type the vault recorded at write time, so this agrees with what
            // archon_list_vault_items reports for the same item.
            mimeType: 'text/plain',
            blob: Buffer.from('item bytes').toString('base64'),
        }]);
        expect(keymaster.getVaultItem).toHaveBeenCalledWith(VAULT_DID, 'notes.txt');
        // A fragment URI must not fall through to the asset reader.
        expect(keymaster.getFile).not.toHaveBeenCalled();
    });

    it('round-trips an item name that needs percent-encoding', async () => {
        const keymaster = mockKeymaster();
        const client = await connect(keymaster);

        // validateAlias only rejects control characters, so names can contain '#' and
        // spaces. The fragment is encoded on the way out and decoded on the way back.
        const name = 'my notes #2.txt';
        const uri = `${VAULT_DID}#${encodeURIComponent(name)}`;

        const result: any = await client.readResource({ uri });

        expect(keymaster.getVaultItem).toHaveBeenCalledWith(VAULT_DID, name);
        expect(result.contents[0].mimeType).toBe('application/json');
        expect(result.contents[0].uri).toBe(uri);
    });

    it('errors when a vault item does not exist', async () => {
        const keymaster = mockKeymaster();
        keymaster.getVaultItem.mockResolvedValue(null);
        const client = await connect(keymaster);

        await expect(client.readResource({ uri: `${VAULT_DID}#missing.txt` })).rejects.toThrow(/not found/i);
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

    it('makes the URI in a vault item tool result dereferenceable', async () => {
        const keymaster = mockKeymaster();
        const server = new McpServer({ name: 'archon-test', version: '0.0.0' });
        const runtime = { node: {} as any, keymaster };
        registerArchonTools(server as any, runtime as any, baseConfig);
        registerArchonResources(server as any, runtime as any);

        const client = new Client({ name: 'archon-test-client', version: '0.0.0' });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        await Promise.all([server.connect(st), client.connect(ct)]);

        // Called with an alias, so this also proves the URI names the resolved DID rather
        // than the alias -- an alias-based URI would be meaningless to another client.
        const called: any = await client.callTool({ name: 'archon_get_vault_item', arguments: { id: 'my-vault', item: 'notes.txt' } });
        const block = (called.content as any[]).find(b => b.type === 'resource');

        expect(block.resource.uri).toBe(`${VAULT_DID}#notes.txt`);

        const read: any = await client.readResource({ uri: block.resource.uri });
        expect(read.contents[0].blob).toBe(block.resource.blob);
        expect(read.contents[0].mimeType).toBe(block.resource.mimeType);
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

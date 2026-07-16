import { jest } from '@jest/globals';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ARCHON_MCP_TOOL_DEFINITIONS, registerArchonTools, McpServerConfig } from '@didcid/mcp-server';

const baseConfig: McpServerConfig = {
    nodeUrl: 'http://localhost:4224',
    walletType: 'json',
    walletPath: './wallet.json',
    passphrase: 'secret',
    defaultRegistry: undefined,
    readOnly: false,
};

// A DID document with the fields a real gatekeeper returns, including ones the output
// schema deliberately does not enumerate ('@context', a service entry, didDocumentData).
// The schema must accept all of it: the SDK emits additionalProperties from the zod
// object, and a client rejects any field the schema forbids.
const didDocument = {
    didDocument: {
        '@context': ['https://www.w3.org/ns/did/v1'],
        id: 'did:cid:alice',
        controller: 'did:cid:alice',
        verificationMethod: [{ id: '#key-1', controller: 'did:cid:alice', type: 'EcdsaSecp256k1VerificationKey2019', publicKeyJwk: { kty: 'EC' } }],
        authentication: ['#key-1'],
        service: [{ id: '#lightning', type: 'LightningPayment', serviceEndpoint: { uri: 'https://example.com', routingKeys: [] } }],
    },
    didDocumentMetadata: { created: '2026-01-01T00:00:00Z', version: 1 },
    didResolutionMetadata: { contentType: 'application/did+ld+json' },
    didDocumentData: { hello: 'world' },
};

function mockKeymaster() {
    return {
        resolveDID: jest.fn<any>().mockResolvedValue(didDocument),
        checkWallet: jest.fn<any>().mockResolvedValue({ checked: 3, invalid: 1, deleted: 0 }),
        viewPoll: jest.fn<any>().mockResolvedValue({
            description: 'Best option?',
            options: ['yes', 'no'],
            deadline: '2026-12-01T00:00:00Z',
            isOwner: true,
            isEligible: true,
            voteExpired: false,
            hasVoted: false,
        }),
        viewBallot: jest.fn<any>().mockResolvedValue({ poll: 'did:cid:poll', voter: 'did:cid:alice', vote: 1, option: 'yes' }),
    };
}

async function connect(keymaster: any) {
    const server = new McpServer({ name: 'archon-test', version: '0.0.0' });
    registerArchonTools(server as any, { node: {} as any, keymaster }, baseConfig);

    const client = new Client({ name: 'archon-test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    return client;
}

describe('mcp server output schemas', () => {
    it('advertises outputSchema only on tools that declare one', async () => {
        const client = await connect(mockKeymaster());
        const listed = await client.listTools();

        const advertised = listed.tools.filter(tool => tool.outputSchema).map(tool => tool.name).sort();
        const declared = ARCHON_MCP_TOOL_DEFINITIONS.filter(d => d.outputSchema).map(d => d.name).sort();

        expect(advertised).toStrictEqual(declared);
        expect(advertised.length).toBeGreaterThan(0);
    });

    // The SDK validates structuredContent against the declared schema on the server, and a
    // client re-validates against the published JSON Schema. These calls therefore fail if
    // a declared shape does not match what keymaster really returns -- see the next test
    // for the shape that failure takes.
    it('round-trips every declared tool through a real client without validation errors', async () => {
        const client = await connect(mockKeymaster());

        const resolved: any = await client.callTool({ name: 'archon_resolve_did', arguments: { did: 'did:cid:alice' } });
        expect(resolved.isError).toBeFalsy();
        expect(resolved.structuredContent).toStrictEqual(didDocument);

        const checked: any = await client.callTool({ name: 'archon_check_wallet', arguments: {} });
        expect(checked.structuredContent).toStrictEqual({ checked: 3, invalid: 1, deleted: 0 });

        const poll: any = await client.callTool({ name: 'archon_view_poll', arguments: { poll: 'did:cid:poll' } });
        expect(poll.structuredContent.options).toStrictEqual(['yes', 'no']);

        const ballot: any = await client.callTool({ name: 'archon_view_ballot', arguments: { ballot: 'did:cid:ballot' } });
        expect(ballot.structuredContent.vote).toBe(1);
    });

    it('rejects a declared tool whose result does not match its schema', async () => {
        const keymaster = mockKeymaster();
        keymaster.checkWallet.mockResolvedValue({ checked: 'three', invalid: 1, deleted: 0 });
        const client = await connect(keymaster);

        // Guards the contract itself: if drift ever makes a declared shape wrong, this is
        // the failure users would see. The server catches its own output-validation error
        // and reports it as a tool error, so a bad schema degrades to a failed call rather
        // than a broken session -- but the call still fails, which is why output schemas
        // are only declared where the shape is known to hold.
        const response: any = await client.callTool({ name: 'archon_check_wallet', arguments: {} });

        expect(response.isError).toBe(true);
        expect(response.content[0].text).toMatch(/checked/);
    });

    it('reports tool errors without tripping output validation', async () => {
        const keymaster = mockKeymaster();
        keymaster.resolveDID.mockRejectedValue(new Error('DID not found'));
        const client = await connect(keymaster);

        // isError results carry no structuredContent; the SDK must not demand it.
        const response: any = await client.callTool({ name: 'archon_resolve_did', arguments: { did: 'did:cid:nope' } });
        expect(response.isError).toBe(true);
        expect(response.content[0].text).toContain('DID not found');
    });
});

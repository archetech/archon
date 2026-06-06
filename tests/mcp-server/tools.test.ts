import { jest } from '@jest/globals';
import { ARCHON_MCP_TOOL_DEFINITIONS, registerArchonTools, McpServerConfig } from '@didcid/mcp-server';

type ToolHandler = (args?: unknown) => Promise<any>;

class FakeServer {
    tools = new Map<string, { config: any; handler: ToolHandler }>();

    registerTool(name: string, config: any, handler: ToolHandler) {
        this.tools.set(name, { config, handler });
    }
}

const baseConfig: McpServerConfig = {
    nodeUrl: 'http://localhost:4224',
    walletType: 'json',
    walletPath: './wallet.json',
    passphrase: 'secret',
    defaultRegistry: undefined,
    readOnly: false,
};

const mutatingTools = ARCHON_MCP_TOOL_DEFINITIONS.filter(definition => definition.mutates).map(definition => definition.name);
const readTools = ARCHON_MCP_TOOL_DEFINITIONS.filter(definition => !definition.mutates).map(definition => definition.name);

function parseToolResult(response: any) {
    return JSON.parse(response.content[0].text);
}

function mockRuntime(overrides: Record<string, unknown> = {}) {
    const defaults: Record<string, any> = {
        loadWallet: jest.fn().mockResolvedValue({ version: 2, ids: {} }),
        newWallet: jest.fn().mockResolvedValue({ version: 2, ids: {} }),
        changePassphrase: jest.fn().mockResolvedValue(true),
        checkWallet: jest.fn().mockResolvedValue({ checked: 0, invalid: 0, deleted: 0 }),
        fixWallet: jest.fn().mockResolvedValue({ idsRemoved: 0, ownedRemoved: 0, heldRemoved: 0, aliasesRemoved: 0 }),
        exportEncryptedWallet: jest.fn().mockResolvedValue({ version: 2, mnemonicEnc: 'encrypted' }),
        saveWallet: jest.fn().mockResolvedValue(true),
        decryptMnemonic: jest.fn().mockResolvedValue('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'),
        backupWallet: jest.fn().mockResolvedValue('did:cid:wallet'),
        recoverWallet: jest.fn().mockResolvedValue({ version: 2, ids: {} }),
        listIds: jest.fn().mockResolvedValue(['alice']),
        getCurrentId: jest.fn().mockResolvedValue('alice'),
        setCurrentId: jest.fn().mockResolvedValue(true),
        createId: jest.fn().mockResolvedValue('did:cid:new'),
        backupId: jest.fn().mockResolvedValue(true),
        recoverId: jest.fn().mockResolvedValue('alice'),
        removeId: jest.fn().mockResolvedValue(true),
        renameId: jest.fn().mockResolvedValue(true),
        rotateKeys: jest.fn().mockResolvedValue(true),
        revokeDID: jest.fn().mockResolvedValue(true),
        changeRegistry: jest.fn().mockResolvedValue(true),
        encryptMessage: jest.fn().mockResolvedValue('did:cid:encrypted'),
        decryptMessage: jest.fn().mockResolvedValue('plaintext'),
        decryptJSON: jest.fn().mockResolvedValue({ hello: 'world' }),
        addProof: jest.fn().mockResolvedValue({ proof: {} }),
        verifyProof: jest.fn().mockResolvedValue(true),
        createChallenge: jest.fn().mockResolvedValue('did:cid:challenge'),
        createResponse: jest.fn().mockResolvedValue('did:cid:response'),
        verifyResponse: jest.fn().mockResolvedValue({ match: true }),
        bindCredential: jest.fn().mockResolvedValue({ type: ['VerifiableCredential'] }),
        issueCredential: jest.fn().mockResolvedValue('did:cid:credential'),
        listIssued: jest.fn().mockResolvedValue(['did:cid:credential']),
        updateCredential: jest.fn().mockResolvedValue(true),
        revokeCredential: jest.fn().mockResolvedValue(true),
        acceptCredential: jest.fn().mockResolvedValue(true),
        listCredentials: jest.fn().mockResolvedValue(['did:cid:credential']),
        getCredential: jest.fn().mockResolvedValue({ type: ['VerifiableCredential'] }),
        publishCredential: jest.fn().mockResolvedValue({ type: ['VerifiableCredential'] }),
        unpublishCredential: jest.fn().mockResolvedValue('OK'),
        resolveDID: jest.fn().mockResolvedValue({ didDocument: { id: 'did:cid:alice' } }),
        listAliases: jest.fn().mockResolvedValue({ me: 'did:cid:alice' }),
        addAlias: jest.fn().mockResolvedValue(true),
        getAlias: jest.fn().mockResolvedValue('did:cid:alice'),
        removeAlias: jest.fn().mockResolvedValue(true),
        listAddresses: jest.fn().mockResolvedValue({}),
        getAddress: jest.fn().mockResolvedValue({ address: 'alice@example.com' }),
        importAddress: jest.fn().mockResolvedValue({}),
        checkAddress: jest.fn().mockResolvedValue({ available: true }),
        addAddress: jest.fn().mockResolvedValue(true),
        removeAddress: jest.fn().mockResolvedValue(true),
        publishAddress: jest.fn().mockResolvedValue(true),
        unpublishAddress: jest.fn().mockResolvedValue(true),
        addNostr: jest.fn().mockResolvedValue({ npub: 'npub...' }),
        importNostr: jest.fn().mockResolvedValue({ npub: 'npub...' }),
        removeNostr: jest.fn().mockResolvedValue(true),
        addLightning: jest.fn().mockResolvedValue({ walletId: 'wallet' }),
        removeLightning: jest.fn().mockResolvedValue(true),
        getLightningBalance: jest.fn().mockResolvedValue({ balance: 0 }),
        decodeLightningInvoice: jest.fn().mockResolvedValue({ amount: '1 sats' }),
        createLightningInvoice: jest.fn().mockResolvedValue({ bolt11: 'lnbc...' }),
        payLightningInvoice: jest.fn().mockResolvedValue({ paymentHash: 'hash' }),
        checkLightningPayment: jest.fn().mockResolvedValue({ paid: true }),
        publishLightning: jest.fn().mockResolvedValue(true),
        unpublishLightning: jest.fn().mockResolvedValue(true),
        zapLightning: jest.fn().mockResolvedValue({ paymentHash: 'hash' }),
        getLightningPayments: jest.fn().mockResolvedValue([]),
        createGroup: jest.fn().mockResolvedValue('did:cid:group'),
        listGroups: jest.fn().mockResolvedValue(['did:cid:group']),
        getGroup: jest.fn().mockResolvedValue({ members: [] }),
        addGroupMember: jest.fn().mockResolvedValue(true),
        removeGroupMember: jest.fn().mockResolvedValue(true),
        testGroup: jest.fn().mockResolvedValue(true),
        createSchema: jest.fn().mockResolvedValue('did:cid:schema'),
        listSchemas: jest.fn().mockResolvedValue(['did:cid:schema']),
        getSchema: jest.fn().mockResolvedValue({ type: 'object' }),
        createTemplate: jest.fn().mockResolvedValue({ propertyName: 'TBD' }),
        listAssets: jest.fn().mockResolvedValue(['asset']),
        createAsset: jest.fn().mockResolvedValue('did:cid:asset'),
        createImage: jest.fn().mockResolvedValue('did:cid:image'),
        createFile: jest.fn().mockResolvedValue('did:cid:file'),
        resolveAsset: jest.fn().mockResolvedValue({ hello: 'world' }),
        getImage: jest.fn().mockResolvedValue({ file: { filename: 'image.png', type: 'image/png', data: Buffer.from('image') }, image: { width: 1, height: 1 } }),
        getFile: jest.fn().mockResolvedValue({ filename: 'file.txt', type: 'text/plain', data: Buffer.from('file') }),
        mergeData: jest.fn().mockResolvedValue(true),
        updateImage: jest.fn().mockResolvedValue(true),
        updateFile: jest.fn().mockResolvedValue(true),
        transferAsset: jest.fn().mockResolvedValue(true),
        cloneAsset: jest.fn().mockResolvedValue('did:cid:clone'),
        pollTemplate: jest.fn().mockResolvedValue({ version: 2 }),
        createPoll: jest.fn().mockResolvedValue('did:cid:poll'),
        addPollVoter: jest.fn().mockResolvedValue(true),
        removePollVoter: jest.fn().mockResolvedValue(true),
        listPollVoters: jest.fn().mockResolvedValue({}),
        viewPoll: jest.fn().mockResolvedValue({}),
        votePoll: jest.fn().mockResolvedValue('did:cid:ballot'),
        sendPoll: jest.fn().mockResolvedValue('did:cid:notice'),
        sendBallot: jest.fn().mockResolvedValue('did:cid:notice'),
        viewBallot: jest.fn().mockResolvedValue({}),
        updatePoll: jest.fn().mockResolvedValue(true),
        publishPoll: jest.fn().mockResolvedValue(true),
        unpublishPoll: jest.fn().mockResolvedValue(true),
        createVault: jest.fn().mockResolvedValue('did:cid:vault'),
        listVaultItems: jest.fn().mockResolvedValue({}),
        addVaultMember: jest.fn().mockResolvedValue(true),
        removeVaultMember: jest.fn().mockResolvedValue(true),
        listVaultMembers: jest.fn().mockResolvedValue({}),
        addVaultItem: jest.fn().mockResolvedValue(true),
        removeVaultItem: jest.fn().mockResolvedValue(true),
        getVaultItem: jest.fn().mockResolvedValue(Buffer.from('vault')),
        createDmail: jest.fn().mockResolvedValue('did:cid:dmail'),
        updateDmail: jest.fn().mockResolvedValue(true),
        sendDmail: jest.fn().mockResolvedValue('did:cid:notice'),
        getDmailMessage: jest.fn().mockResolvedValue({ subject: 'hello' }),
        listDmail: jest.fn().mockResolvedValue({}),
        fileDmail: jest.fn().mockResolvedValue(true),
        refreshNotices: jest.fn().mockResolvedValue(true),
        importDmail: jest.fn().mockResolvedValue(true),
        removeDmail: jest.fn().mockResolvedValue(true),
        addDmailAttachment: jest.fn().mockResolvedValue(true),
        removeDmailAttachment: jest.fn().mockResolvedValue(true),
        getDmailAttachment: jest.fn().mockResolvedValue(Buffer.from('attachment')),
        listDmailAttachments: jest.fn().mockResolvedValue({}),
        ...overrides,
    };

    return {
        node: {
            getVersion: jest.fn().mockResolvedValue({ version: '0.10.0', commit: 'abc123' }),
            getStatus: jest.fn().mockResolvedValue({ ready: true }),
            listRegistries: jest.fn().mockResolvedValue(['hyperswarm']),
        },
        keymaster: defaults,
    };
}

describe('mcp server tools', () => {
    it('registers the CLI-complete tool surface', () => {
        const server = new FakeServer();
        registerArchonTools(server, mockRuntime() as any, baseConfig);

        expect([...server.tools.keys()].sort()).toStrictEqual(ARCHON_MCP_TOOL_DEFINITIONS.map(definition => definition.name).sort());
    });

    it('calls read tools and returns compact JSON payloads', async () => {
        const server = new FakeServer();
        const runtime = mockRuntime();
        registerArchonTools(server, runtime as any, baseConfig);

        const response = await server.tools.get('archon_list_registries')!.handler({});

        expect(parseToolResult(response)).toStrictEqual({ ok: true, result: ['hyperswarm'] });
        expect(runtime.node.listRegistries).toHaveBeenCalledTimes(1);
    });

    it('does not advertise mutating tools in read-only mode', () => {
        const server = new FakeServer();
        const runtime = mockRuntime();
        registerArchonTools(server, runtime as any, { ...baseConfig, readOnly: true });

        expect([...server.tools.keys()].sort()).toStrictEqual(readTools.sort());
        for (const tool of mutatingTools) {
            expect(server.tools.has(tool)).toBe(false);
        }
        expect(runtime.keymaster.createId).not.toHaveBeenCalled();
    });

    it('requires explicit confirmation for destructive tools', async () => {
        const server = new FakeServer();
        const runtime = mockRuntime();
        registerArchonTools(server, runtime as any, baseConfig);

        const response = await server.tools.get('archon_revoke_did')!.handler({ did: 'did:cid:alice' });
        const result = parseToolResult(response);

        expect(result.ok).toBe(false);
        expect(result.error).toContain('Invalid literal value');
        expect(runtime.keymaster.revokeDID).not.toHaveBeenCalled();
    });

    it('requires explicit reveal for secret-revealing tools', async () => {
        const server = new FakeServer();
        const runtime = mockRuntime();
        registerArchonTools(server, runtime as any, baseConfig);

        const response = await server.tools.get('archon_show_mnemonic')!.handler({});
        const result = parseToolResult(response);

        expect(result.ok).toBe(false);
        expect(result.error).toContain('Invalid literal value');
        expect(runtime.keymaster.decryptMnemonic).not.toHaveBeenCalled();
    });

    it('returns a clear passphrase error for wallet-backed tools without keymaster runtime', async () => {
        const server = new FakeServer();
        registerArchonTools(server, { node: mockRuntime().node } as any, { ...baseConfig, passphrase: undefined });

        const response = await server.tools.get('archon_list_ids')!.handler({});

        expect(parseToolResult(response)).toStrictEqual({
            ok: false,
            error: 'ARCHON_PASSPHRASE is required for wallet-backed MCP tools',
        });
    });

    it('validates required inputs', async () => {
        const server = new FakeServer();
        const runtime = mockRuntime();
        registerArchonTools(server, runtime as any, baseConfig);

        const response = await server.tools.get('archon_create_id')!.handler({});
        const result = parseToolResult(response);

        expect(result.ok).toBe(false);
        expect(result.error).toContain('Required');
        expect(runtime.keymaster.createId).not.toHaveBeenCalled();
    });

    it('passes optional inputs to keymaster calls', async () => {
        const server = new FakeServer();
        const runtime = mockRuntime();
        registerArchonTools(server, runtime as any, baseConfig);

        const response = await server.tools.get('archon_create_asset_json')!.handler({
            data: { hello: 'world' },
            alias: 'hello',
            registry: 'hyperswarm',
        });

        expect(parseToolResult(response)).toStrictEqual({ ok: true, result: 'did:cid:asset' });
        expect(runtime.keymaster.createAsset).toHaveBeenCalledWith(
            { hello: 'world' },
            { alias: 'hello', registry: 'hyperswarm' }
        );
    });

    it('passes inline base64 payloads to file-like tools', async () => {
        const server = new FakeServer();
        const runtime = mockRuntime();
        registerArchonTools(server, runtime as any, baseConfig);

        const response = await server.tools.get('archon_create_asset_file')!.handler({
            file: {
                name: 'hello.txt',
                mimeType: 'text/plain',
                data: Buffer.from('hello').toString('base64'),
            },
            alias: 'hello',
        });

        expect(parseToolResult(response)).toStrictEqual({ ok: true, result: 'did:cid:file' });
        expect(runtime.keymaster.createFile).toHaveBeenCalledWith(
            Buffer.from('hello'),
            { alias: 'hello', filename: 'hello.txt', contentType: 'text/plain' }
        );
    });

    it('returns file-like assets as inline payloads', async () => {
        const server = new FakeServer();
        const runtime = mockRuntime();
        registerArchonTools(server, runtime as any, baseConfig);

        const fileResponse = await server.tools.get('archon_get_asset_file')!.handler({ id: 'did:cid:file' });
        expect(parseToolResult(fileResponse)).toStrictEqual({
            ok: true,
            result: {
                name: 'file.txt',
                mimeType: 'text/plain',
                encoding: 'base64',
                data: Buffer.from('file').toString('base64'),
            },
        });

        const imageResponse = await server.tools.get('archon_get_asset_image')!.handler({ id: 'did:cid:image' });
        expect(parseToolResult(imageResponse)).toStrictEqual({
            ok: true,
            result: {
                file: {
                    name: 'image.png',
                    mimeType: 'image/png',
                    encoding: 'base64',
                    data: Buffer.from('image').toString('base64'),
                },
                image: {
                    width: 1,
                    height: 1,
                },
            },
        });
    });

    it('redacts secrets from tool errors', async () => {
        const server = new FakeServer();
        const runtime = mockRuntime({
            listIds: jest.fn().mockRejectedValue(
                new Error('failed ARCHON_PASSPHRASE="my secret phrase" recoveryPhrase=seed words nsec=nsec-secret bolt11=lnbc-secret https://user:pass@bitcoin-mainnet.g.alchemy.com/v3/api-token?api_key=123')
            ),
        });
        registerArchonTools(server, runtime as any, baseConfig);

        const response = await server.tools.get('archon_list_ids')!.handler({});
        const result = parseToolResult(response);

        expect(result.ok).toBe(false);
        expect(result.error).toContain('ARCHON_PASSPHRASE=<redacted>');
        expect(result.error).toContain('https://<redacted>@bitcoin-mainnet.g.alchemy.com/v3/<redacted>?api_key=<redacted>');
        expect(result.error).not.toContain('secret');
        expect(result.error).not.toContain('phrase');
        expect(result.error).not.toContain('seed');
        expect(result.error).not.toContain('words');
        expect(result.error).not.toContain('nsec-secret');
        expect(result.error).not.toContain('lnbc-secret');
        expect(result.error).not.toContain('api-token');
    });
});

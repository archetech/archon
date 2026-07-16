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
const inlineFile = {
    name: 'hello.txt',
    mimeType: 'text/plain',
    data: Buffer.from('hello').toString('base64'),
};

const defaultToolArgs = {
    address: 'alice@example.com',
    alias: 'alice-alias',
    amount: 21,
    anoncrypt: true,
    attachment: inlineFile,
    ballot: 'did:cid:ballot',
    bolt11: 'lnbc...',
    challenge: { prompt: 'prove it' },
    claims: { name: 'Alice' },
    config: { version: 2, name: 'Poll', description: 'Best option?', options: ['yes', 'no'], deadline: '2099-01-01T00:00:00Z' },
    confirm: true,
    confirmPayment: true,
    controller: 'did:cid:bob',
    credential: {
        '@context': ['https://www.w3.org/ns/credentials/v2'],
        type: ['VerifiableCredential'],
        issuer: 'did:cid:issuer',
        validFrom: '2026-01-01T00:00:00Z',
        credentialSubject: { id: 'did:cid:alice', name: 'Alice' },
    },
    data: { hello: 'world' },
    did: 'did:cid:alice',
    domain: 'example.com',
    encryption: 'XC20P',
    endpoint: 'https://example.com/didcomm',
    file: inlineFile,
    group: 'did:cid:group',
    groupName: 'Friends',
    id: 'did:cid:asset',
    includeIds: true,
    issuer: 'did:cid:issuer',
    item: inlineFile,
    key: 'hello',
    member: 'did:cid:member',
    memo: 'coffee',
    message: { to: ['did:cid:bob'], cc: [], subject: 'hi', body: 'hello' },
    name: 'Alice',
    newName: 'Alicia',
    newPassphrase: 'new secret',
    nsec: 'nsec1example',
    object: { hello: 'world' },
    oldName: 'Alice',
    owner: 'did:cid:alice',
    packed: 'packed-message',
    paymentHash: 'hash',
    poll: 'did:cid:poll',
    recoveryPhrase: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    registry: 'hyperswarm',
    recipient: 'did:cid:bob',
    response: 'did:cid:response',
    reveal: true,
    routingKeys: ['did:cid:mediator#key-agreement-1'],
    schema: { type: 'object' },
    sign: true,
    subject: 'did:cid:subject',
    tags: ['inbox'],
    to: 'did:cid:bob',
    validFrom: '2026-01-01T00:00:00.000Z',
    validUntil: '2026-12-31T00:00:00.000Z',
    value: 'world',
    version: 1,
    vote: 1,
    wallet: { version: 2, seed: { mnemonicEnc: { salt: 's', iv: 'i', data: 'd' } }, counter: 0, ids: {} },
};

const toolArgOverrides: Record<string, Record<string, unknown>> = {
    archon_bind_credential: { schema: 'did:cid:schema' },
    archon_create_response: { challenge: 'did:cid:challenge' },
    archon_create_schema_template: { schema: 'did:cid:schema' },
    archon_encrypt_message: { message: 'hello' },
    archon_remove_vault_item: { item: 'hello.txt' },
    archon_get_vault_item: { item: 'hello.txt' },
};

// Asserts a spec-shaped success: no isError, and structuredContent (when the result is a
// JSON object) mirrors the serialized text block. Returns the payload. Tools that emit
// image/resource blocks carry their metadata in a trailing text block, so this looks the
// text block up by type rather than assuming it comes first.
function expectOk(response: any) {
    if (response.isError) {
        throw new Error(`unexpected tool error: ${response.content[0].text}`);
    }

    const textBlock = response.content.find((block: any) => block.type === 'text');
    expect(textBlock).toBeDefined();

    const text = textBlock.text;
    const payload = text === '' ? undefined : JSON.parse(text);

    if (isJsonObject(payload)) {
        expect(response.structuredContent).toStrictEqual(payload);
    } else {
        expect(response.structuredContent).toBeUndefined();
    }

    return payload;
}

// Asserts a spec-shaped tool execution error. Returns the message.
function expectFail(response: any): string {
    expect(response.isError).toBe(true);
    expect(response.structuredContent).toBeUndefined();

    return response.content[0].text;
}

function isJsonObject(value: unknown) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function argsForTool(name: string) {
    return {
        ...defaultToolArgs,
        ...(toolArgOverrides[name] || {}),
    };
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
        lookupDID: jest.fn().mockResolvedValue('did:cid:file'),
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
        publishDidComm: jest.fn().mockResolvedValue(true),
        unpublishDidComm: jest.fn().mockResolvedValue(true),
        packDidComm: jest.fn().mockResolvedValue('packed'),
        unpackDidComm: jest.fn().mockResolvedValue({ body: 'hello' }),
        sendDidComm: jest.fn().mockResolvedValue(['msg-1']),
        receiveDidComm: jest.fn().mockResolvedValue([{ body: 'hello' }]),
        mediateDidComm: jest.fn().mockResolvedValue({ forwarded: 1 }),
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

        expect(expectOk(response)).toStrictEqual(['hyperswarm']);
        expect(runtime.node.listRegistries).toHaveBeenCalledTimes(1);
    });

    it('executes every registered tool with representative valid inputs', async () => {
        const server = new FakeServer();
        const runtime = mockRuntime();
        registerArchonTools(server, runtime as any, baseConfig);

        for (const definition of ARCHON_MCP_TOOL_DEFINITIONS) {
            const response = await server.tools.get(definition.name)!.handler(argsForTool(definition.name));
            if (response.isError) {
                throw new Error(`${definition.name}: ${response.content[0].text}`);
            }
            expectOk(response);
        }
    });

    it('carries object results in structuredContent, mirrored by the text block', async () => {
        const server = new FakeServer();
        const runtime = mockRuntime();
        registerArchonTools(server, runtime as any, baseConfig);

        const response = await server.tools.get('archon_resolve_did')!.handler({ did: 'did:cid:alice' });

        expect(response.isError).toBeUndefined();
        expect(response.structuredContent).toStrictEqual({ didDocument: { id: 'did:cid:alice' } });
        expect(JSON.parse(response.content[0].text)).toStrictEqual(response.structuredContent);
    });

    it('omits structuredContent for non-object results', async () => {
        const server = new FakeServer();
        const runtime = mockRuntime();
        registerArchonTools(server, runtime as any, baseConfig);

        // MCP requires structuredContent to be a JSON object, so an array result rides the text block alone.
        const listResponse = await server.tools.get('archon_list_ids')!.handler({});
        expect(listResponse.structuredContent).toBeUndefined();
        expect(JSON.parse(listResponse.content[0].text)).toStrictEqual(['alice']);

        const stringResponse = await server.tools.get('archon_create_id')!.handler({ name: 'Alice' });
        expect(stringResponse.structuredContent).toBeUndefined();
        expect(JSON.parse(stringResponse.content[0].text)).toBe('did:cid:new');
    });

    it('omits structuredContent for objects that serialize to a JSON scalar', async () => {
        const server = new FakeServer();
        // A Date is a JS object but serializes to a JSON string, as is anything with a
        // toJSON() returning a non-object. structuredContent must stay a JSON object.
        const runtime = mockRuntime({
            resolveDID: jest.fn().mockResolvedValue(new Date('2026-01-01T00:00:00.000Z')),
            getCredential: jest.fn().mockResolvedValue({ toJSON: () => 'did:cid:credential' }),
        });
        registerArchonTools(server, runtime as any, baseConfig);

        const dateResponse = await server.tools.get('archon_resolve_did')!.handler({ did: 'did:cid:alice' });
        expect(dateResponse.structuredContent).toBeUndefined();
        expect(JSON.parse(dateResponse.content[0].text)).toBe('2026-01-01T00:00:00.000Z');

        const toJsonResponse = await server.tools.get('archon_get_credential')!.handler({ did: 'did:cid:credential' });
        expect(toJsonResponse.structuredContent).toBeUndefined();
        expect(JSON.parse(toJsonResponse.content[0].text)).toBe('did:cid:credential');
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

        expect(expectFail(response)).toContain('Invalid literal value');
        expect(runtime.keymaster.revokeDID).not.toHaveBeenCalled();
    });

    it('requires explicit reveal for secret-revealing tools', async () => {
        const server = new FakeServer();
        const runtime = mockRuntime();
        registerArchonTools(server, runtime as any, baseConfig);

        const response = await server.tools.get('archon_show_mnemonic')!.handler({});

        expect(expectFail(response)).toContain('Invalid literal value');
        expect(runtime.keymaster.decryptMnemonic).not.toHaveBeenCalled();
    });

    it('flags a locked wallet as a tool execution error', async () => {
        const server = new FakeServer();
        registerArchonTools(server, { node: mockRuntime().node } as any, { ...baseConfig, passphrase: undefined });

        const response = await server.tools.get('archon_list_ids')!.handler({});

        expect(response.isError).toBe(true);
        expect(expectFail(response)).toBe('ARCHON_PASSPHRASE is required for wallet-backed MCP tools');
    });

    it('validates required inputs', async () => {
        const server = new FakeServer();
        const runtime = mockRuntime();
        registerArchonTools(server, runtime as any, baseConfig);

        const response = await server.tools.get('archon_create_id')!.handler({});

        expect(expectFail(response)).toContain('Required');
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

        expect(expectOk(response)).toBe('did:cid:asset');
        expect(runtime.keymaster.createAsset).toHaveBeenCalledWith(
            { hello: 'world' },
            { alias: 'hello', registry: 'hyperswarm' }
        );
    });

    // Zod strips unknown keys on parse, so a schema that omits an extension point does not
    // reject data -- it silently deletes it. These two tools carry types that declare
    // `[key: string]: any`, and losing those keys would corrupt a restored wallet or erase
    // a credential's claims, so the schemas must passthrough.
    it('preserves custom metadata when restoring a wallet', async () => {
        const server = new FakeServer();
        const runtime = mockRuntime();
        registerArchonTools(server, runtime as any, baseConfig);

        const wallet = {
            version: 2 as const,
            seed: { mnemonicEnc: { salt: 's', iv: 'i', data: 'd' }, customSeedField: 'keep' },
            counter: 4,
            ids: { alice: { did: 'did:cid:alice', account: 0, index: 1, owned: ['did:cid:asset'], customIdField: 'keep' } },
            current: 'alice',
            aliases: { bob: 'did:cid:bob' },
            customWalletField: 'keep',
        };

        expectOk(await server.tools.get('archon_restore_wallet_file')!.handler({ wallet, confirm: true }));

        // Byte-identical: nothing added, nothing dropped.
        expect(runtime.keymaster.saveWallet).toHaveBeenCalledWith(wallet, true);
    });

    it('preserves credential claims when updating a credential', async () => {
        const server = new FakeServer();
        const runtime = mockRuntime();
        registerArchonTools(server, runtime as any, baseConfig);

        const credential = {
            '@context': ['https://www.w3.org/ns/credentials/v2'],
            type: ['VerifiableCredential'],
            issuer: 'did:cid:issuer',
            validFrom: '2026-01-01T00:00:00Z',
            credentialSubject: { id: 'did:cid:alice', name: 'Alice', age: 30 },
            proof: { type: 'SomeOtherSignature2030', proofValue: 'z1' },
        };

        expectOk(await server.tools.get('archon_update_credential')!.handler({ did: 'did:cid:vc', credential }));

        // The claims under credentialSubject survive, and so does an unmodelled proof --
        // updateCredential deletes and re-signs it, so constraining it would reject
        // credentials keymaster accepts.
        expect(runtime.keymaster.updateCredential).toHaveBeenCalledWith('did:cid:vc', credential);
    });

    it('rejects malformed input at the tool boundary', async () => {
        const server = new FakeServer();
        const runtime = mockRuntime();
        registerArchonTools(server, runtime as any, baseConfig);

        const poll = server.tools.get('archon_create_poll')!.handler;
        const base = { version: 2 as const, name: 'Poll', description: 'd', options: ['a', 'b'], deadline: '2099-01-01' };

        expect(expectFail(await poll({ config: { ...base, options: ['only-one'] } }))).toMatch(/options/);
        expect(expectFail(await poll({ config: { ...base, version: 1 } }))).toMatch(/version/);
        expect(expectFail(await poll({ config: { ...base, name: '' } }))).toMatch(/name/);

        // Previously accepted and passed to keymaster, which failed deeper in.
        expect(expectFail(await poll({ config: { title: 'Poll', options: ['yes', 'no'] } }))).toMatch(/version|name|description|deadline/);
        expect(runtime.keymaster.createPoll).not.toHaveBeenCalled();

        const dmail = server.tools.get('archon_create_dmail')!.handler;
        expect(expectFail(await dmail({ message: { to: [], subject: 's', body: 'b' } }))).toMatch(/to/);
        expect(expectFail(await dmail({ message: { to: ['did:cid:bob'], subject: '', body: 'b' } }))).toMatch(/subject/);
    });

    it('defaults an omitted dmail cc to an empty list', async () => {
        const server = new FakeServer();
        const runtime = mockRuntime();
        registerArchonTools(server, runtime as any, baseConfig);

        // keymaster's verifyRecipientList throws InvalidParameterError('list') on a missing
        // cc, which reads as a bug rather than a missing field. Defaulting is strictly more
        // permissive than the old behaviour, so nothing that worked before breaks.
        expectOk(await server.tools.get('archon_create_dmail')!.handler({
            message: { to: ['did:cid:bob'], subject: 'hi', body: 'hello' },
        }));

        expect(runtime.keymaster.createDmail).toHaveBeenCalledWith(
            { to: ['did:cid:bob'], cc: [], subject: 'hi', body: 'hello' },
            undefined
        );
    });

    it('accepts both wallet forms on restore', async () => {
        const server = new FakeServer();
        const runtime = mockRuntime();
        registerArchonTools(server, runtime as any, baseConfig);

        // StoredWallet is a union; saveWallet decrypts the encrypted form itself. Neither
        // form holds a plaintext secret -- the seed is passphrase-encrypted in both, and only
        // the metadata (counter/ids/aliases) differs in whether it is wrapped in `enc`.
        const encrypted = { version: 2, seed: { mnemonicEnc: { salt: 's', iv: 'i', data: 'd' } }, enc: 'ciphertext' };
        expectOk(await server.tools.get('archon_restore_wallet_file')!.handler({ wallet: encrypted, confirm: true }));
        expect(runtime.keymaster.saveWallet).toHaveBeenCalledWith(encrypted, true);

        const unencryptedMetadata = { version: 2, seed: { mnemonicEnc: { salt: 's', iv: 'i', data: 'd' } }, counter: 1, ids: {} };
        expectOk(await server.tools.get('archon_restore_wallet_file')!.handler({ wallet: unencryptedMetadata, confirm: true }));
        expect(runtime.keymaster.saveWallet).toHaveBeenLastCalledWith(unencryptedMetadata, true);

        // Neither branch matches, so the union rejects rather than guessing.
        expect(expectFail(await server.tools.get('archon_restore_wallet_file')!.handler({ wallet: { seed: {} }, confirm: true }))).toMatch(/enc|counter|ids|mnemonicEnc/);
    });

    it('accepts a v1 wallet and preserves its legacy names field', async () => {
        const server = new FakeServer();
        const runtime = mockRuntime();
        registerArchonTools(server, runtime as any, baseConfig);

        // keymaster's upgradeWallet renames `names` to `aliases` for v1 wallets, so the
        // schema must not drop `names` before it ever gets there -- passthrough carries it.
        const v1 = {
            version: 1,
            seed: { mnemonicEnc: { salt: 's', iv: 'i', data: 'd' } },
            counter: 2,
            ids: {},
            names: { bob: 'did:cid:bob' },
        };

        expectOk(await server.tools.get('archon_restore_wallet_file')!.handler({ wallet: v1, confirm: true }));
        expect(runtime.keymaster.saveWallet).toHaveBeenCalledWith(v1, true);

        // Both guards require version 1|2, so a v3 wallet is rejected at the boundary
        // rather than reaching keymaster's "Unsupported wallet version." deeper in.
        expect(expectFail(await server.tools.get('archon_restore_wallet_file')!.handler({
            wallet: { ...v1, version: 3 }, confirm: true,
        }))).toMatch(/version/);
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

        expect(expectOk(response)).toBe('did:cid:file');
        expect(runtime.keymaster.createFile).toHaveBeenCalledWith(
            Buffer.from('hello'),
            { alias: 'hello', filename: 'hello.txt', contentType: 'text/plain' }
        );
    });

    it('returns an image asset as an image content block', async () => {
        const server = new FakeServer();
        const runtime = mockRuntime();
        registerArchonTools(server, runtime as any, baseConfig);

        const response: any = await server.tools.get('archon_get_asset_image')!.handler({ id: 'did:cid:image' });

        expect(response.isError).toBeUndefined();
        const metadata = { name: 'image.png', mimeType: 'image/png', image: { width: 1, height: 1 } };
        expect(response.content).toStrictEqual([
            { type: 'image', data: Buffer.from('image').toString('base64'), mimeType: 'image/png' },
            { type: 'text', text: JSON.stringify(metadata) },
        ]);
        expect(response.structuredContent).toStrictEqual(metadata);
    });

    it('returns a file asset as an embedded resource content block', async () => {
        const server = new FakeServer();
        const runtime = mockRuntime();
        registerArchonTools(server, runtime as any, baseConfig);

        const response: any = await server.tools.get('archon_get_asset_file')!.handler({ id: 'file-alias' });

        expect(response.isError).toBeUndefined();
        expect(response.content).toStrictEqual([
            {
                type: 'resource',
                resource: {
                    uri: 'did:cid:file',
                    mimeType: 'text/plain',
                    blob: Buffer.from('file').toString('base64'),
                },
            },
            { type: 'text', text: JSON.stringify({ name: 'file.txt', mimeType: 'text/plain' }) },
        ]);
        expect(response.structuredContent).toStrictEqual({ name: 'file.txt', mimeType: 'text/plain' });
        // Resolved once, then getFile is handed the DID rather than the alias: getFile
        // resolves internally too, and resolving an alias decrypts the wallet.
        expect(runtime.keymaster.lookupDID).toHaveBeenCalledTimes(1);
        expect(runtime.keymaster.lookupDID).toHaveBeenCalledWith('file-alias');
        expect(runtime.keymaster.getFile).toHaveBeenCalledWith('did:cid:file');
    });

    it('defaults the mimeType and drops absent metadata from both mirrors', async () => {
        const server = new FakeServer();
        const runtime = mockRuntime();
        runtime.keymaster.getFile.mockResolvedValue({ data: Buffer.from('file') });
        registerArchonTools(server, runtime as any, baseConfig);

        const response: any = await server.tools.get('archon_get_asset_file')!.handler({ id: 'did:cid:file' });

        expect((response.content[0] as any).resource.mimeType).toBe('application/octet-stream');
        // structuredContent must be exactly the text block's payload: an absent filename
        // is dropped by both, not left as an undefined key on one side.
        expect(response.structuredContent).toStrictEqual({ mimeType: 'application/octet-stream' });
        expect(JSON.parse(response.content[1].text)).toStrictEqual(response.structuredContent);
    });

    it('returns null for file-like assets with no data', async () => {
        const server = new FakeServer();
        const runtime = mockRuntime();
        runtime.keymaster.getImage.mockResolvedValue(null);
        runtime.keymaster.getFile.mockResolvedValue(null);
        registerArchonTools(server, runtime as any, baseConfig);

        expect(expectOk(await server.tools.get('archon_get_asset_image')!.handler({ id: 'did:cid:image' }))).toBeNull();
        expect(expectOk(await server.tools.get('archon_get_asset_file')!.handler({ id: 'did:cid:file' }))).toBeNull();
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
        const error = expectFail(response);

        expect(error).toContain('ARCHON_PASSPHRASE=<redacted>');
        expect(error).toContain('https://<redacted>@bitcoin-mainnet.g.alchemy.com/v3/<redacted>?api_key=<redacted>');
        expect(error).not.toContain('secret');
        expect(error).not.toContain('phrase');
        expect(error).not.toContain('seed');
        expect(error).not.toContain('words');
        expect(error).not.toContain('nsec-secret');
        expect(error).not.toContain('lnbc-secret');
        expect(error).not.toContain('api-token');
    });
});

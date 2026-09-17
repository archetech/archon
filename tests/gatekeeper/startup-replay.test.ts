import { jest } from '@jest/globals';
import CipherNode from '@didcid/cipher/node';
import Gatekeeper from '@didcid/gatekeeper';
import DbJsonMemory from '@didcid/gatekeeper/db/json-memory.ts';
import MemoryClient from '@didcid/ipfs/memory';
import TestHelper from './helper.ts';

it.each([false, true])('replays independent histories safely with mixed-type evidence: %s', async mixed => {
    const db = new DbJsonMemory('parallel-replay');
    const gatekeeper = new Gatekeeper({ db, ipfs: new MemoryClient() });
    const cipher = new CipherNode();
    const helper = new TestHelper(gatekeeper, cipher);
    let controller = '';
    let controllerKey = cipher.generateJwk(new Uint8Array(32).fill(1));
    let agentHint;
    const agentDids: string[] = [];
    for (let i = 1; i <= 64; i++) {
        const keypair = cipher.generateJwk(new Uint8Array(32).fill(i));
        const operation = await helper.createAgentOp(keypair);
        const did = await gatekeeper.generateDID(operation);
        agentDids.push(did);
        if (!controller || did < controller) {
            controller = did;
            controllerKey = keypair;
        }
        agentHint = operation;
        await db.setEvents(did, [{
            registry: 'local', time: operation.created!, operation,
            did, opid: await gatekeeper.generateCID(operation),
        }]);
    }
    let operation;
    let asset;
    let attempt = 0;
    const firstGroupEnd = agentDids.sort()[31];
    do {
        operation = await helper.createAssetOp(controller, controllerKey, { data: `mockData-${attempt++}` });
        asset = await gatekeeper.generateDID(operation);
    } while (asset < controller || asset >= firstGroupEnd);
    await db.setEvents(asset, [{
        registry: 'local', time: operation.created!, operation,
        did: asset, opid: await gatekeeper.generateCID(operation),
    }]);

    if (mixed) {
        // An invalid agent create can be retained under an asset DID. Its
        // presence must not let that asset race its unfinished controller.
        await db.setCandidates(asset, [
            ...(await db.getEvents(asset)),
            { registry: 'local', time: agentHint!.created!, operation: agentHint!,
                did: asset, opid: await gatekeeper.generateCID(agentHint!) },
        ]);
    }

    let active = 0;
    let peak = 0;
    let agentsCompleted = 0;
    let assetsVerified = 0;
    const completedKeys = new Set<string>();
    const verify = CipherNode.prototype.verifyMessage;
    const proofChecks = jest.spyOn(CipherNode.prototype, 'verifyMessage').mockImplementation(async function (this: CipherNode, message, signature, key) {
        const signed = JSON.parse(message as string);
        const agent = signed.registration.type === 'agent';
        if (!agent) {
            if (!mixed) expect(agentsCompleted).toBe(64);
            expect(completedKeys.has(controllerKey.publicJwk.x)).toBe(true);
            assetsVerified++;
        }
        peak = Math.max(peak, ++active);
        try {
            await new Promise(resolve => setTimeout(resolve, 1));
            const valid = await verify.call(this, message, signature, key);
            if (agent && valid) {
                agentsCompleted++;
                completedKeys.add(signed.publicJwk.x);
            }
            return valid;
        } finally {
            active--;
        }
    });
    try {
        expect((await gatekeeper.resolveDID(asset)).didDocumentData).toBe(operation.data);
        expect(assetsVerified).toBe(1);
        expect(agentsCompleted).toBe(64);
        expect(await db.getEvents(asset)).toHaveLength(1);
        expect(peak).toBeGreaterThan(1);
        expect(peak).toBeLessThan(64);
    } finally {
        proofChecks.mockRestore();
    }
});

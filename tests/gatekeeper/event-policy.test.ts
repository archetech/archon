import { readFileSync } from 'node:fs';
import { generateCID } from '@didcid/ipfs/utils';
import type { GatekeeperEvent } from '@didcid/gatekeeper/types';
import { candidateKey, isLocallyStampedRegistry, isUnanchoredRegistry, normalizeEventTime,
    preferredCandidates, queueKey, relayHints } from '../../packages/gatekeeper/src/event-policy.ts';

type Policy = { registry: string; locallyStamped: boolean; unanchored: boolean; createTime: string;
    updateTime: string; relay: string; candidateFields: (keyof GatekeeperEvent)[]; keepFirst: boolean };
const policies: Policy[] = JSON.parse(readFileSync('tests/convergence/event-policy.json', 'utf8'));
const receiptTime = '2026-09-03T00:00:00Z';
const signed = JSON.parse(readFileSync('tests/convergence/event-target-vectors.json', 'utf8'))[0].operations;
signed.push(JSON.parse(readFileSync('tests/convergence/local-receipt-counterexample.json', 'utf8'))[0].events[0].operation);

it.each(policies)('preserves envelope and evidence policy for $registry', async policy => {
    expect(isLocallyStampedRegistry(policy.registry)).toBe(policy.locallyStamped);
    expect(isUnanchoredRegistry(policy.registry)).toBe(policy.unanchored);
    for (const source of signed) {
        const operation = structuredClone(source);
        const intrinsic = { created: operation.created, proof: operation.proof.created, receipt: receiptTime };
        const event: GatekeeperEvent = { registry: policy.registry, time: receiptTime, ordinal: [10, 2, 0],
            operation, opid: await generateCID(operation, { canonical: true }),
            registration: { height: 10, index: 2, opidx: 0, txid: 'tx', batch: 'batch' } };
        const before = structuredClone(event);
        const queued = queueKey(event, event.opid!);
        expect(queued).toBe(`${event.registry}/${event.opid}/${JSON.stringify([event.time, event.ordinal])}`);
        const hints = relayHints([event]);
        expect(hints[0].registry).toBe(policy.relay);
        expect(hints[0].registration).toEqual(policy.locallyStamped ? event.registration : undefined);
        expect(hints[0].operation).toEqual(operation);
        expect(hints[0].ordinal).toEqual(event.ordinal);
        expect(event).toEqual(before);

        normalizeEventTime(event);
        const clock = operation.type === 'create' ? policy.createTime : policy.updateTime;
        expect(event.time).toBe(intrinsic[clock as keyof typeof intrinsic]);
        expect({ ...event, time: before.time }).toEqual(before);
        const normalized = structuredClone(event);
        normalizeEventTime(event);
        expect(event).toEqual(normalized);
        expect(candidateKey(event)).toBe(JSON.stringify(policy.candidateFields.map(field => event[field])));
        const copy = structuredClone(event);
        expect(preferredCandidates([event, copy])[0]).toBe(policy.keepFirst ? event : copy);
        const otherPosition = { ...copy, ordinal: [10, 2, 1] };
        expect(preferredCandidates([event, otherPosition])).toHaveLength(policy.locallyStamped ? 1 : 2);
        const plain = { ...event, registration: undefined };
        expect(queueKey(plain, event.opid!)).toBe(`${event.registry}/${event.opid}`);
    }
});

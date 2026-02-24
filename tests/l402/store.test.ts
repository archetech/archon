import { L402StoreMemory } from '../../packages/l402/src/store-memory.js';
import type { MacaroonRecord, PaymentRecord, PendingInvoiceData } from '../../packages/l402/src/types.js';

describe('L402 Store (Memory)', () => {
    let store: L402StoreMemory;

    beforeEach(() => {
        store = new L402StoreMemory();
    });

    describe('Macaroon CRUD', () => {
        const macaroon: MacaroonRecord = {
            id: 'mac-001',
            did: 'did:cid:test',
            scope: ['resolveDID'],
            createdAt: Math.floor(Date.now() / 1000),
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
            maxUses: 10,
            currentUses: 0,
            paymentHash: 'hash123',
            revoked: false,
        };

        it('should save and retrieve a macaroon', async () => {
            await store.saveMacaroon(macaroon);
            const retrieved = await store.getMacaroon('mac-001');

            expect(retrieved).not.toBeNull();
            expect(retrieved!.id).toBe('mac-001');
            expect(retrieved!.did).toBe('did:cid:test');
            expect(retrieved!.scope).toEqual(['resolveDID']);
        });

        it('should return null for non-existent macaroon', async () => {
            const retrieved = await store.getMacaroon('nonexistent');
            expect(retrieved).toBeNull();
        });

        it('should revoke a macaroon', async () => {
            await store.saveMacaroon(macaroon);
            await store.revokeMacaroon('mac-001');

            const retrieved = await store.getMacaroon('mac-001');
            expect(retrieved!.revoked).toBe(true);
        });

        it('should increment usage', async () => {
            await store.saveMacaroon(macaroon);

            const usage1 = await store.incrementUsage('mac-001');
            expect(usage1).toBe(1);

            const usage2 = await store.incrementUsage('mac-001');
            expect(usage2).toBe(2);

            const retrieved = await store.getMacaroon('mac-001');
            expect(retrieved!.currentUses).toBe(2);
        });

        it('should throw when incrementing non-existent macaroon', async () => {
            await expect(store.incrementUsage('nonexistent')).rejects.toThrow();
        });

        it('should return copies, not references', async () => {
            await store.saveMacaroon(macaroon);
            const retrieved = await store.getMacaroon('mac-001');
            retrieved!.did = 'modified';

            const retrieved2 = await store.getMacaroon('mac-001');
            expect(retrieved2!.did).toBe('did:cid:test');
        });
    });

    describe('Payment CRUD', () => {
        const payment: PaymentRecord = {
            id: 'pay-001',
            did: 'did:cid:test',
            method: 'lightning',
            paymentHash: 'hash123',
            amountSat: 100,
            createdAt: Math.floor(Date.now() / 1000),
            macaroonId: 'mac-001',
        };

        it('should save and retrieve a payment', async () => {
            await store.savePayment(payment);
            const retrieved = await store.getPayment('pay-001');

            expect(retrieved).not.toBeNull();
            expect(retrieved!.id).toBe('pay-001');
            expect(retrieved!.method).toBe('lightning');
            expect(retrieved!.amountSat).toBe(100);
        });

        it('should return null for non-existent payment', async () => {
            const retrieved = await store.getPayment('nonexistent');
            expect(retrieved).toBeNull();
        });

        it('should retrieve payments by DID', async () => {
            await store.savePayment(payment);
            await store.savePayment({
                ...payment,
                id: 'pay-002',
                amountSat: 200,
            });

            const didPayments = await store.getPaymentsByDid('did:cid:test');
            expect(didPayments).toHaveLength(2);
        });

        it('should return empty array for DID with no payments', async () => {
            const didPayments = await store.getPaymentsByDid('did:cid:nobody');
            expect(didPayments).toHaveLength(0);
        });
    });

    describe('Pending Invoices', () => {
        const pending: PendingInvoiceData = {
            paymentHash: 'hash123',
            macaroonId: 'mac-001',
            serializedMacaroon: 'test-serialized-macaroon',
            did: 'did:cid:test',
            scope: ['resolveDID'],
            amountSat: 100,
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
            createdAt: Math.floor(Date.now() / 1000),
        };

        it('should save and retrieve a pending invoice', async () => {
            await store.savePendingInvoice(pending);
            const retrieved = await store.getPendingInvoice('hash123');

            expect(retrieved).not.toBeNull();
            expect(retrieved!.paymentHash).toBe('hash123');
            expect(retrieved!.macaroonId).toBe('mac-001');
        });

        it('should return null for non-existent pending invoice', async () => {
            const retrieved = await store.getPendingInvoice('nonexistent');
            expect(retrieved).toBeNull();
        });

        it('should delete a pending invoice', async () => {
            await store.savePendingInvoice(pending);
            await store.deletePendingInvoice('hash123');

            const retrieved = await store.getPendingInvoice('hash123');
            expect(retrieved).toBeNull();
        });
    });

    describe('Rate Limiting', () => {
        it('should allow requests under the limit', async () => {
            const result = await store.checkRateLimit('did:cid:test', 10, 3600);
            expect(result.allowed).toBe(true);
            expect(result.remaining).toBe(10);
        });

        it('should record requests and decrement remaining', async () => {
            await store.recordRequest('did:cid:test', 3600);
            await store.recordRequest('did:cid:test', 3600);

            const result = await store.checkRateLimit('did:cid:test', 10, 3600);
            expect(result.remaining).toBe(8);
        });

        it('should deny requests at the limit', async () => {
            for (let i = 0; i < 5; i++) {
                await store.recordRequest('did:cid:test', 3600);
            }

            const result = await store.checkRateLimit('did:cid:test', 5, 3600);
            expect(result.allowed).toBe(false);
            expect(result.remaining).toBe(0);
        });
    });

    describe('clear', () => {
        it('should clear all data', async () => {
            await store.saveMacaroon({
                id: 'mac-001',
                did: 'did:cid:test',
                scope: [],
                createdAt: 0,
                expiresAt: 0,
                maxUses: 0,
                currentUses: 0,
                paymentHash: '',
                revoked: false,
            });
            await store.savePayment({
                id: 'pay-001',
                did: 'did:cid:test',
                method: 'lightning',
                paymentHash: '',
                amountSat: 0,
                createdAt: 0,
                macaroonId: '',
            });

            store.clear();

            expect(await store.getMacaroon('mac-001')).toBeNull();
            expect(await store.getPayment('pay-001')).toBeNull();
        });
    });

    describe('getAllPayments', () => {
        it('should return all payments', async () => {
            await store.savePayment({
                id: 'pay-001',
                did: 'did:cid:alice',
                method: 'lightning',
                paymentHash: 'h1',
                amountSat: 100,
                createdAt: 1000,
                macaroonId: 'mac-001',
            });
            await store.savePayment({
                id: 'pay-002',
                did: 'did:cid:bob',
                method: 'cashu',
                paymentHash: 'h2',
                amountSat: 200,
                createdAt: 2000,
                macaroonId: 'mac-002',
            });

            const all = await store.getAllPayments();
            expect(all).toHaveLength(2);
        });
    });
});

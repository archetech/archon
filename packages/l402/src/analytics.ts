import type { L402Store, PaymentAnalytics, PaymentRecord } from './types.js';
import { L402StoreMemory } from './store-memory.js';

export async function getPaymentAnalytics(
    store: L402Store,
    _options?: { did?: string; since?: number }
): Promise<PaymentAnalytics> {
    let payments: PaymentRecord[];

    // The memory store has a getAllPayments helper; for other stores,
    // we aggregate from DID-level queries
    if (store instanceof L402StoreMemory) {
        payments = await store.getAllPayments();
    } else {
        // For Redis or other stores, the caller should provide a DID filter
        if (_options?.did) {
            payments = await store.getPaymentsByDid(_options.did);
        } else {
            // Cannot enumerate all payments in a generic store without a scan
            payments = [];
        }
    }

    if (_options?.since) {
        payments = payments.filter(p => p.createdAt >= _options.since!);
    }

    const analytics: PaymentAnalytics = {
        totalPayments: payments.length,
        totalRevenueSat: 0,
        byMethod: {},
        byDid: {},
        byScope: {},
    };

    for (const payment of payments) {
        analytics.totalRevenueSat += payment.amountSat;

        // By method
        if (!analytics.byMethod[payment.method]) {
            analytics.byMethod[payment.method] = { count: 0, revenueSat: 0 };
        }
        analytics.byMethod[payment.method].count += 1;
        analytics.byMethod[payment.method].revenueSat += payment.amountSat;

        // By DID
        if (!analytics.byDid[payment.did]) {
            analytics.byDid[payment.did] = { count: 0, revenueSat: 0 };
        }
        analytics.byDid[payment.did].count += 1;
        analytics.byDid[payment.did].revenueSat += payment.amountSat;

        // By scope
        if (payment.scope) {
            for (const s of payment.scope) {
                analytics.byScope[s] = (analytics.byScope[s] || 0) + 1;
            }
        }
    }

    return analytics;
}

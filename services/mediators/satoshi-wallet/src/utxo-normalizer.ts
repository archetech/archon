function extractArray(payload: any): any[] {
    if (Array.isArray(payload)) {
        return payload;
    }
    if (Array.isArray(payload?.utxos)) {
        return payload.utxos;
    }
    if (Array.isArray(payload?.data)) {
        return payload.data;
    }
    if (Array.isArray(payload?.result)) {
        return payload.result;
    }
    if (Array.isArray(payload?.result?.utxos)) {
        return payload.result.utxos;
    }
    if (Array.isArray(payload?.outputs)) {
        return payload.outputs;
    }
    return [];
}

function toSats(value: any): number {
    if (typeof value === 'number') {
        return Number.isInteger(value) ? value : Math.round(value * 100_000_000);
    }
    if (typeof value === 'bigint') {
        return Number(value);
    }
    if (typeof value === 'string') {
        if (value.startsWith('0x')) {
            return Number.parseInt(value, 16);
        }
        if (value.includes('.')) {
            return Math.round(Number.parseFloat(value) * 100_000_000);
        }
        return Number.parseInt(value, 10);
    }
    return 0;
}

function toConfirmations(value: any): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

export interface NormalizedRawUtxo {
    txid: string;
    vout: number;
    valueSats: number;
    confirmations: number;
}

export function normalizeHostedUtxos(payload: any): NormalizedRawUtxo[] {
    return extractArray(payload)
        .map((item: any) => {
            const txid = item.txid || item.txId || item.hash || item.tx_hash || item.transactionHash;
            const vout = item.vout ?? item.outputIndex ?? item.index ?? item.n;
            const value = item.value ?? item.satoshis ?? item.amount ?? item.valueSats ?? item.value_sat;
            const confirmations = item.confirmations
                ?? item.confirmedConfirmations
                ?? item.numConfirmations
                ?? (item.status?.confirmed ? 1 : 0);

            return {
                txid,
                vout: Number(vout),
                valueSats: toSats(value),
                confirmations: toConfirmations(confirmations),
            };
        })
        .filter(utxo => Boolean(utxo.txid)
            && Number.isInteger(utxo.vout)
            && Number.isFinite(utxo.valueSats)
            && utxo.valueSats > 0);
}

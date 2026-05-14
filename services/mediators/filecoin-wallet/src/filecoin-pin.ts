/**
 * Filecoin storage layer using the filecoin-pin npm library.
 *
 * Flow: fetch operation JSON from IPFS → CAR file → Synapse upload to Filecoin.
 * Each Archon operation CID is stored as a separate piece on Filecoin.
 */
import { initializeSynapse, checkUploadReadiness, executeUpload } from 'filecoin-pin';
import { mainnet, calibration } from 'filecoin-pin/core/synapse';
import type { SynapseSetupConfig, UploadExecutionResult } from 'filecoin-pin';
import { createReadStream } from 'node:fs';
import { writeFile, unlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { CID } from 'multiformats/cid';
import axios from 'axios';
import pino from 'pino';
import config from './config.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

export interface PinRecord {
    requestid: string;
    status: 'queued' | 'pinning' | 'pinned' | 'failed';
    created: string;
    pin: { cid: string; did: string; name?: string };
    filecoin?: {
        pieceCid: string;
        network: string;
        ipniValidated: boolean;
    };
    error?: string;
}

const pinRegistry = new Map<string, PinRecord>();

let _synapse: Awaited<ReturnType<typeof initializeSynapse>> | null = null;

async function getSynapse() {
    if (_synapse) return _synapse;

    let synapseConfig: SynapseSetupConfig;

    if (config.privateKey) {
        const privateKey = config.privateKey.startsWith('0x')
            ? config.privateKey as `0x${string}`
            : `0x${config.privateKey}` as `0x${string}`;
        synapseConfig = {
            privateKey,
            chain: config.network === 'calibration' ? calibration : mainnet,
            ...(config.rpcUrl && { rpcUrl: config.rpcUrl }),
        };
    } else if (config.walletAddress && config.sessionKey) {
        synapseConfig = {
            walletAddress: config.walletAddress as `0x${string}`,
            sessionKey: config.sessionKey as `0x${string}`,
            chain: config.network === 'calibration' ? calibration : mainnet,
            ...(config.rpcUrl && { rpcUrl: config.rpcUrl }),
        };
    } else {
        throw new Error(
            'Filecoin auth not configured. Set ARCHON_FIL_PRIVATE_KEY or ' +
            'ARCHON_FIL_WALLET_ADDRESS + ARCHON_FIL_SESSION_KEY'
        );
    }

    _synapse = await initializeSynapse(synapseConfig, logger);
    return _synapse;
}

export async function pinCid(cid: string, did: string, name?: string): Promise<PinRecord> {
    const requestid = randomUUID();
    const record: PinRecord = {
        requestid,
        status: 'queued',
        created: new Date().toISOString(),
        pin: { cid, did, name },
    };
    pinRegistry.set(requestid, record);

    // Pin asynchronously; update record in place
    doPinAsync(requestid, cid, did).catch(err => {
        const r = pinRegistry.get(requestid);
        if (r) {
            r.status = 'failed';
            r.error = String(err?.message ?? err);
        }
        logger.error({ err, cid, did, requestid }, 'Pin operation failed');
    });

    return record;
}

async function doPinAsync(requestid: string, cid: string, did: string): Promise<void> {
    const record = pinRegistry.get(requestid)!;
    record.status = 'pinning';

    let tempCarPath: string | undefined;

    try {
        // 1. Export the DAG node as a CAR directly from IPFS.
        //    Archon operations are DAG-CBOR/DAG-JSON nodes, not UnixFS files,
        //    so dag/export is the correct endpoint (cat only handles UnixFS).
        const response = await axios.post<ArrayBuffer>(
            `${config.ipfsApiUrl}/api/v0/dag/export?arg=${encodeURIComponent(cid)}`,
            null,
            { responseType: 'arraybuffer', timeout: 30_000 }
        );
        const carBytes = Buffer.from(response.data);

        // 2. Write the CAR to a temp file
        tempCarPath = join(tmpdir(), `archon-op-${requestid}.car`);
        await writeFile(tempCarPath, carBytes);

        // 3. Check Synapse payment readiness
        const carStat = await stat(tempCarPath);
        const synapse = await getSynapse();

        const readiness = await checkUploadReadiness({ synapse, fileSize: carStat.size });
        if (readiness.status === 'blocked') {
            throw new Error(
                `Filecoin payment not ready: ${readiness.validation.errorMessage ?? 'insufficient balance'}. ` +
                `${readiness.validation.helpMessage ?? ''}`
            );
        }

        // 4. Upload to Filecoin via Synapse
        const rootCid = CID.parse(cid);
        const carStream = Readable.toWeb(createReadStream(tempCarPath)) as ReadableStream<Uint8Array>;
        const uploadResult: UploadExecutionResult = await executeUpload(
            synapse,
            carStream,
            rootCid as any,
            {
                logger,
                contextId: requestid,
                pieceMetadata: { archonCid: cid, archonDid: did },
            }
        );

        record.status = 'pinned';
        record.filecoin = {
            pieceCid: uploadResult.pieceCid,
            network: uploadResult.network,
            ipniValidated: uploadResult.ipniValidated,
        };

    } finally {
        if (tempCarPath) await unlink(tempCarPath).catch(() => {});
    }
}

export function getPinStatus(requestid: string): PinRecord | undefined {
    return pinRegistry.get(requestid);
}

export function listPins(status?: PinRecord['status']): PinRecord[] {
    const all = Array.from(pinRegistry.values());
    return status ? all.filter(p => p.status === status) : all;
}

export function removePin(requestid: string): boolean {
    return pinRegistry.delete(requestid);
}

export async function getPaymentInfo(): Promise<unknown> {
    const synapse = await getSynapse();
    return {
        network: config.network,
        chain: synapse.chain.name,
        note: 'Run filecoin-pin payments status for full balance info',
    };
}

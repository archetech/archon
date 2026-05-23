import axios from 'axios';
import pino from 'pino';
import { initializeSynapse, checkUploadReadiness, executeUpload } from 'filecoin-pin';
import { mainnet, calibration } from 'filecoin-pin/core/synapse';
import type { SynapseSetupConfig } from 'filecoin-pin';
import { CID } from 'multiformats/cid';
import { createReadStream } from 'node:fs';
import { stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import config from './config.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

export interface WalletPinResult {
    requestid: string;
    status: 'pinned';
    cid: string;
    fingerprint?: string;
    registry?: string;
    filecoin: {
        pieceCid: string;
        network: string;
        ipniValidated: boolean;
    };
}

let synapseClient: Awaited<ReturnType<typeof initializeSynapse>> | null = null;

function prefixedHex(value: string): `0x${string}` {
    return value.startsWith('0x') ? value as `0x${string}` : `0x${value}` as `0x${string}`;
}

async function getSynapse() {
    if (synapseClient) {
        return synapseClient;
    }

    let synapseConfig: SynapseSetupConfig;

    if (config.privateKey) {
        synapseConfig = {
            privateKey: prefixedHex(config.privateKey),
            chain: config.network === 'calibration' ? calibration : mainnet,
            ...(config.rpcUrl && { rpcUrl: config.rpcUrl }),
        };
    } else if (config.walletAddress && config.sessionKey) {
        synapseConfig = {
            walletAddress: prefixedHex(config.walletAddress),
            sessionKey: prefixedHex(config.sessionKey),
            chain: config.network === 'calibration' ? calibration : mainnet,
            ...(config.rpcUrl && { rpcUrl: config.rpcUrl }),
        };
    } else {
        throw new Error('Filecoin auth not configured. Set ARCHON_FIL_PRIVATE_KEY or ARCHON_FIL_WALLET_ADDRESS plus ARCHON_FIL_SESSION_KEY');
    }

    synapseClient = await initializeSynapse(synapseConfig, logger);
    return synapseClient;
}

export async function pinCid(cid: string, fingerprint?: string, registry?: string): Promise<WalletPinResult> {
    const requestid = randomUUID();
    let tempCarPath: string | undefined;

    try {
        const response = await axios.post<ArrayBuffer>(
            `${config.ipfsApiUrl}/dag/export?arg=${encodeURIComponent(cid)}`,
            null,
            { responseType: 'arraybuffer', timeout: 30_000 }
        );
        const carBytes = Buffer.from(response.data);

        tempCarPath = join(tmpdir(), `archon-filecoin-${requestid}.car`);
        await writeFile(tempCarPath, carBytes);

        const carStat = await stat(tempCarPath);
        const synapse = await getSynapse();
        const readiness = await checkUploadReadiness({ synapse, fileSize: carStat.size });

        if (readiness.status === 'blocked') {
            throw new Error(`Filecoin payment not ready: ${readiness.validation.errorMessage ?? 'insufficient balance'}`);
        }

        const rootCid = CID.parse(cid);
        const carStream = Readable.toWeb(createReadStream(tempCarPath)) as ReadableStream<Uint8Array>;
        const uploadResult: any = await executeUpload(
            synapse,
            carStream,
            rootCid as any,
            {
                logger,
                contextId: requestid,
                pieceMetadata: {
                    archonCid: cid,
                    ...(fingerprint && { archonFingerprint: fingerprint }),
                    ...(registry && { archonRegistry: registry }),
                },
            }
        );

        return {
            requestid,
            status: 'pinned',
            cid,
            fingerprint,
            registry,
            filecoin: {
                pieceCid: uploadResult.pieceCid,
                network: uploadResult.network,
                ipniValidated: Boolean(uploadResult.ipniValidated),
            },
        };
    } finally {
        if (tempCarPath) {
            await unlink(tempCarPath).catch(() => {});
        }
    }
}

export async function getPaymentInfo(): Promise<unknown> {
    const synapse = await getSynapse();
    return {
        network: config.network,
        chain: synapse.chain.name,
    };
}

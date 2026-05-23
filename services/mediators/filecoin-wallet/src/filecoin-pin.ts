import axios from 'axios';
import pino from 'pino';
import { initializeSynapse, checkUploadReadiness, executeUpload } from 'filecoin-pin';
import { mainnet, calibration } from 'filecoin-pin/core/synapse';
import { getPaymentStatus } from 'filecoin-pin/core/payments';
import type { SynapseSetupConfig } from 'filecoin-pin';
import type { PaymentStatus } from 'filecoin-pin/core/payments';
import { CID } from 'multiformats/cid';
import { createReadStream } from 'node:fs';
import { stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import config from './config.js';
import { deriveAddress, derivePrivateKey } from './derivation.js';

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
        depositTx?: string;
    };
}

let synapseClient: Awaited<ReturnType<typeof initializeSynapse>> | null = null;
let walletPrivateKey: `0x${string}` | null = null;
let walletAddress: string | null = null;

export function configureWallet(mnemonic: string): string {
    walletPrivateKey = derivePrivateKey(mnemonic, config.derivationPath);
    walletAddress = deriveAddress(mnemonic, config.derivationPath);
    synapseClient = null;
    return walletAddress;
}

export function getWalletAddress(): string {
    if (!walletAddress) {
        throw new Error('Filecoin wallet not configured');
    }
    return walletAddress;
}

async function getSynapse() {
    if (synapseClient) {
        return synapseClient;
    }

    if (!walletPrivateKey) {
        throw new Error('Filecoin wallet not configured');
    }

    const synapseConfig: SynapseSetupConfig = {
        privateKey: walletPrivateKey,
        chain: config.network === 'calibration' ? calibration : mainnet,
        ...(config.rpcUrl && { rpcUrl: config.rpcUrl }),
    };

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
        let depositTx: string | undefined;
        const prepare = await (synapse as any).storage.prepare({ dataSize: BigInt(carStat.size) });
        if (prepare.transaction) {
            let submittedTx: string | undefined;
            const result = await prepare.transaction.execute({
                onHash: (hash: string) => {
                    submittedTx = hash;
                },
            });
            depositTx = submittedTx ?? result.hash;
            logger.info({
                depositTx,
                amount: prepare.transaction.depositAmount.toString(),
                includesApproval: prepare.transaction.includesApproval,
            }, 'Prepared Filecoin Pay for upload');
        }

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
                ...(depositTx && { depositTx }),
            },
        };
    } finally {
        if (tempCarPath) {
            await unlink(tempCarPath).catch(() => {});
        }
    }
}

function stringifyBigInts(value: unknown): unknown {
    if (typeof value === 'bigint') {
        return value.toString();
    }
    if (Array.isArray(value)) {
        return value.map(stringifyBigInts);
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [key, stringifyBigInts(item)])
        );
    }
    return value;
}

export async function getPaymentInfo(): Promise<unknown> {
    const synapse = await getSynapse();
    const status = await getPaymentStatus(synapse) as PaymentStatus;
    return stringifyBigInts({
        ...status,
        derivationPath: config.derivationPath,
    });
}

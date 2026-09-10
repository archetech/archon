import type express from 'express';
import {
    ArchonError,
    LightningUnavailableError,
    UnknownIDError,
    WalletNotFoundError,
} from '@didcid/common/errors';

// Status by error class, the classification the Python service also uses
// (docs/services/keymaster/README.md §16.3, #1103/#1108). Routes used to hardcode
// a status in each catch block, inconsistently -- the same class of failure came
// back 400 on one route and 500 on another. Classifying by the thrown error puts
// a client error at 4xx and a server fault at 5xx wherever it is raised.
export function statusForError(error: unknown): number {
    if (error instanceof UnknownIDError || error instanceof WalletNotFoundError) {
        return 404;
    }
    if (error instanceof LightningUnavailableError) {
        // An upstream service is down -- not the caller's fault, not this
        // node's bug either.
        return 503;
    }
    if (error instanceof ArchonError) {
        // Every other Archon error is a bad request: invalid parameter, invalid
        // DID, invalid operation, an unmet precondition.
        return 400;
    }
    // An error this service did not classify is an unexpected fault.
    return 500;
}

export function sendError(res: express.Response, error: unknown): void {
    res.status(statusForError(error)).send({ error: error instanceof Error ? error.toString() : String(error) });
}

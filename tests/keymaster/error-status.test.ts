import { jest } from '@jest/globals';
import type express from 'express';
import { sendNotFound, statusForError } from '../../services/keymaster/server/src/keymaster-error-status.ts';
import { GatekeeperTimeoutError, GatekeeperUnavailableError } from '@didcid/clients/gatekeeper';
import {
    InvalidDIDError,
    InvalidOperationError,
    InvalidParameterError,
    KeymasterError,
    LightningNotConfiguredError,
    LightningUnavailableError,
    UnknownIDError,
    WalletNotFoundError,
} from '@didcid/common/errors';

// The classification the JS keymaster service maps every caught error through,
// matching the Python service (README §16.3, #1108).
describe('statusForError', () => {
    it('maps not-found errors to 404', () => {
        expect(statusForError(new UnknownIDError('x'))).toBe(404);
        expect(statusForError(new WalletNotFoundError('x'))).toBe(404);
    });

    it('maps an unavailable upstream service to 503', () => {
        expect(statusForError(new LightningUnavailableError('x'))).toBe(503);
        expect(statusForError(new GatekeeperUnavailableError('x'))).toBe(503);
    });

    it('maps a Gatekeeper timeout to 504', () => {
        expect(statusForError(new GatekeeperTimeoutError('x'))).toBe(504);
    });

    it('maps every other Archon error — a client error — to 400', () => {
        expect(statusForError(new InvalidParameterError('x'))).toBe(400);
        expect(statusForError(new InvalidDIDError('x'))).toBe(400);
        expect(statusForError(new InvalidOperationError('x'))).toBe(400);
        expect(statusForError(new KeymasterError('x'))).toBe(400);
        expect(statusForError(new LightningNotConfiguredError('x'))).toBe(400);
    });

    it('maps an unclassified error to 500', () => {
        expect(statusForError(new Error('boom'))).toBe(500);
        expect(statusForError('a string')).toBe(500);
        expect(statusForError(undefined)).toBe(500);
    });
});

// Resolve-style routes answer 404 for a failed resolution, except when the
// failure is Gatekeeper itself (#1380).
describe('sendNotFound', () => {
    function response() {
        const res = { status: jest.fn(), send: jest.fn() };
        res.status.mockReturnValue(res);
        return res;
    }

    it('answers 404 with the route body for a resolution failure', () => {
        const res = response();
        sendNotFound(res as unknown as express.Response, new UnknownIDError('x'), { error: 'DID not found' });
        expect(res.status).toHaveBeenCalledWith(404);
        expect(res.send).toHaveBeenCalledWith({ error: 'DID not found' });
    });

    it.each([
        [new GatekeeperTimeoutError('Gatekeeper did not respond'), 504],
        [new GatekeeperUnavailableError('Gatekeeper unavailable'), 503],
    ])('passes %s through with its own status', (error, status) => {
        const res = response();
        sendNotFound(res as unknown as express.Response, error, { error: 'DID not found' });
        expect(res.status).toHaveBeenCalledWith(status);
        expect(res.send).toHaveBeenCalledWith({ error: error.toString() });
    });
});

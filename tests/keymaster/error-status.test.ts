import { statusForError } from '../../services/keymaster/server/src/keymaster-error-status.ts';
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

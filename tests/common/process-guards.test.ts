import { EventEmitter } from 'events';
import { installProcessGuards } from '@didcid/common/process-guards';

// A service that logs a startup failure and carries on is worse off than one
// that crashes: it binds its port before reaching its dependencies, so it ends
// up answering requests with nothing behind it (#1053). The guards are fatal
// until the service says it is up, and tolerant afterwards so that one bad
// request cannot end it.

function guard() {
    const target = new EventEmitter();
    const exits: number[] = [];
    const messages: string[] = [];

    const startupComplete = installProcessGuards('Service', {
        target,
        exit: (code) => { exits.push(code); },
        log: (message) => { messages.push(message); },
    });

    return { target, exits, messages, startupComplete };
}

describe('installProcessGuards', () => {
    it('ends the process on a rejection raised before startup finishes', () => {
        const { target, exits } = guard();

        target.emit('unhandledRejection', new Error('gatekeeper unreachable'));

        expect(exits).toStrictEqual([1]);
    });

    it('ends the process on an exception raised before startup finishes', () => {
        const { target, exits } = guard();

        target.emit('uncaughtException', new Error('wallet store missing'));

        expect(exits).toStrictEqual([1]);
    });

    it('names the service and says why it is exiting', () => {
        const { target, messages } = guard();

        target.emit('unhandledRejection', new Error('gatekeeper unreachable'));

        expect(messages[0]).toBe('Service: unhandled rejection');
        expect(messages[1]).toBe('Service: startup did not finish, exiting');
    });

    it('logs and continues once startup has finished', () => {
        const { target, exits, messages, startupComplete } = guard();

        startupComplete();
        target.emit('unhandledRejection', new Error('one bad request'));
        target.emit('uncaughtException', new Error('another bad request'));

        expect(exits).toStrictEqual([]);
        expect(messages).toStrictEqual(['Service: unhandled rejection', 'Service: uncaught exception']);
    });

    it('installs on the real process by default', () => {
        const before = {
            uncaughtException: new Set<unknown>(process.listeners('uncaughtException')),
            unhandledRejection: new Set<unknown>(process.listeners('unhandledRejection')),
        };

        // Marked complete immediately, and removed below: a handler of ours
        // left on this worker would end the run on any later stray rejection.
        installProcessGuards('Service', { exit: () => { }, log: () => { } })();

        const added = {
            uncaughtException: process.listeners('uncaughtException').filter(listener => !before.uncaughtException.has(listener)),
            unhandledRejection: process.listeners('unhandledRejection').filter(listener => !before.unhandledRejection.has(listener)),
        };

        try {
            expect([added.uncaughtException.length, added.unhandledRejection.length]).toStrictEqual([1, 1]);
        }
        finally {
            added.uncaughtException.forEach(listener => process.removeListener('uncaughtException', listener));
            added.unhandledRejection.forEach(listener => process.removeListener('unhandledRejection', listener));
        }
    });
});

import { mkdtempSync, readFileSync, rmSync, statSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
    Auth,
    AuthError,
    generateSetupCode,
    hashPassword,
    SESSION_TTL_MS,
    verifyPassword,
} from '../../services/node-runner/server/src/auth.ts';

const PASSWORD = 'correct horse battery';

let dataDir: string;
let now: number;
let logs: string[];

function makeAuth(): Auth {
    return new Auth({ dataDir, log: m => logs.push(m), now: () => now, failureDelayMs: 0 });
}

beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'node-runner-auth-'));
    now = 1_000_000;
    logs = [];
});

afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
});

async function expectAuthError(promise: Promise<unknown>, status: number): Promise<void> {
    await expect(promise).rejects.toBeInstanceOf(AuthError);
    await expect(promise).rejects.toMatchObject({ status });
}

describe('setup codes', () => {
    it('are three groups of four unambiguous characters', () => {
        for (let i = 0; i < 50; i++) {
            expect(generateSetupCode()).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
        }
    });

    it('is written privately to the data directory and logged', async () => {
        const code = await makeAuth().ensureSetupCode();

        const path = join(dataDir, 'setup-code');
        expect(readFileSync(path, 'utf-8').trim()).toBe(code);
        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(logs.join('\n')).toContain(code!);
    });

    it('survives a restart unchanged, so the code the installer printed keeps working', async () => {
        const first = await makeAuth().ensureSetupCode();
        const second = await makeAuth().ensureSetupCode(true);

        expect(second).toBe(first);
    });

    it('logs an existing code only when asked', async () => {
        const auth = makeAuth();
        await auth.ensureSetupCode();
        logs = [];

        await auth.ensureSetupCode();
        expect(logs).toEqual([]);
    });
});

describe('first-run setup', () => {
    it('refuses a wrong code', async () => {
        const auth = makeAuth();
        await auth.ensureSetupCode();

        await expectAuthError(auth.setup('AAAA-AAAA-AAAA', PASSWORD), 401);
        expect(await auth.isConfigured()).toBe(false);
    });

    it('refuses when no code was ever issued', async () => {
        await expectAuthError(makeAuth().setup('', PASSWORD), 401);
    });

    it('refuses a short password', async () => {
        const auth = makeAuth();
        const code = await auth.ensureSetupCode();

        await expectAuthError(auth.setup(code!, 'short'), 400);
    });

    it('stores only a hash, retires the code and starts a session', async () => {
        const auth = makeAuth();
        const code = await auth.ensureSetupCode();

        const token = await auth.setup(code!.toLowerCase().replace(/-/g, ' '), PASSWORD);

        const stored = readFileSync(join(dataDir, 'admin-password'), 'utf-8');
        expect(stored).not.toContain(PASSWORD);
        expect(await verifyPassword(PASSWORD, stored)).toBe(true);
        expect(existsSync(join(dataDir, 'setup-code'))).toBe(false);
        expect(auth.checkSession(token)).toBe(true);
        expect(await auth.ensureSetupCode()).toBeNull();
        await expectAuthError(auth.setup(code!, PASSWORD), 409);
    });
});

describe('concurrent setup', () => {
    it('lets only one of two setups with the same code set the password', async () => {
        const auth = makeAuth();
        const code = (await auth.ensureSetupCode())!;

        const results = await Promise.allSettled([auth.setup(code, 'first password!'), auth.setup(code, 'second password')]);

        expect(results.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected']);
        expect((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
        const winner = results[0].status === 'fulfilled' ? 'first password!' : 'second password';
        expect(await verifyPassword(winner, readFileSync(join(dataDir, 'admin-password'), 'utf-8'))).toBe(true);
    });
});

describe('login and sessions', () => {
    async function configured(): Promise<Auth> {
        const auth = makeAuth();
        await auth.setup((await auth.ensureSetupCode())!, PASSWORD);
        return auth;
    }

    it('accepts the password and refuses anything else', async () => {
        const auth = await configured();

        expect(auth.checkSession(await auth.login(PASSWORD))).toBe(true);
        await expectAuthError(auth.login('wrong password!'), 401);
    });

    it('refuses to log in before setup', async () => {
        await expectAuthError(makeAuth().login(PASSWORD), 409);
    });

    it('expires an idle session and extends an active one', async () => {
        const auth = await configured();
        const token = await auth.login(PASSWORD);

        now += SESSION_TTL_MS - 1;
        expect(auth.checkSession(token)).toBe(true);
        now += SESSION_TTL_MS - 1;
        expect(auth.checkSession(token)).toBe(true);
        now += SESSION_TTL_MS;
        expect(auth.checkSession(token)).toBe(false);
    });

    it('checks a session without extending it', async () => {
        const auth = await configured();
        const token = await auth.login(PASSWORD);

        now += SESSION_TTL_MS - 1;
        expect(auth.peekSession(token)).toBe(true);
        now += 2;
        expect(auth.peekSession(token)).toBe(false);
        expect(auth.peekSession(undefined)).toBe(false);
    });

    it('announces ended sessions: one on logout, all on reset', async () => {
        const auth = await configured();
        const token = await auth.login(PASSWORD);
        const revoked: (string | null)[] = [];
        const stop = auth.onRevoke(t => revoked.push(t));

        auth.logout(token);
        auth.logout(token);
        await auth.login(PASSWORD);
        rmSync(join(dataDir, 'admin-password'));
        await auth.ensureSetupCode();
        stop();
        auth.logout('anything');

        expect(revoked).toEqual([token, null]);
    });

    it('ends a session on logout', async () => {
        const auth = await configured();
        const token = await auth.login(PASSWORD);

        auth.logout(token);
        expect(auth.checkSession(token)).toBe(false);
        expect(auth.checkSession(undefined)).toBe(false);
    });

    it('resets when the hash is deleted: sessions end and a new code is issued', async () => {
        const auth = await configured();
        const token = await auth.login(PASSWORD);

        rmSync(join(dataDir, 'admin-password'));
        const code = await auth.ensureSetupCode();

        expect(code).toMatch(/^[A-Z2-9]{4}-/);
        expect(auth.checkSession(token)).toBe(false);
        expect(logs.at(-1)).toContain(code!);
    });
});

describe('password hashes', () => {
    it('reject a malformed stored value', async () => {
        expect(await verifyPassword(PASSWORD, 'plain-text')).toBe(false);
    });

    it('salt each hash', async () => {
        expect(await hashPassword(PASSWORD)).not.toBe(await hashPassword(PASSWORD));
    });

    it('verify a hash written by hand to the file', async () => {
        writeFileSync(join(dataDir, 'admin-password'), `${await hashPassword(PASSWORD)}\n`);

        const auth = makeAuth();
        expect(auth.checkSession(await auth.login(PASSWORD))).toBe(true);
    });
});

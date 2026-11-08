import { randomBytes, randomInt, scrypt as scryptCallback, timingSafeEqual } from 'crypto';
import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import { join } from 'path';

const SETUP_CODE_FILE = 'setup-code';
const PASSWORD_FILE = 'admin-password';

// No 0/O or 1/I, so a code read from a terminal is typed back correctly.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };

export const MIN_PASSWORD_LENGTH = 12;
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export class AuthError extends Error {
    constructor(message: string, readonly status: number) {
        super(message);
    }
}

function scrypt(password: string, salt: Buffer, N: number, r: number, p: number, keylen: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        scryptCallback(password, salt, keylen, { N, r, p, maxmem: SCRYPT.maxmem }, (err, key) => {
            if (err) {
                reject(err);
            }
            else {
                resolve(key);
            }
        });
    });
}

export function generateSetupCode(): string {
    const chars = Array.from({ length: 12 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]);
    return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8)].map(group => group.join('')).join('-');
}

// Codes are compared without dashes, spaces or case, so either form typed back works.
function canonicalCode(code: string): Buffer {
    return Buffer.from(code.toUpperCase().replace(/[^A-Z0-9]/g, ''));
}

export async function hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16);
    const key = await scrypt(password, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p, SCRYPT.keylen);
    return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join(':');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
    const [scheme, N, r, p, salt, hash] = stored.trim().split(':');
    if (scheme !== 'scrypt' || !hash) {
        return false;
    }
    const expected = Buffer.from(hash, 'base64');
    const key = await scrypt(password, Buffer.from(salt, 'base64'), Number(N), Number(r), Number(p), expected.length);
    return timingSafeEqual(key, expected);
}

async function readOptional(path: string): Promise<string | null> {
    try {
        return await fs.readFile(path, 'utf-8');
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return null;
        }
        throw error;
    }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export interface AuthOptions {
    dataDir: string;
    log?: (message: string) => void;
    now?: () => number;
    failureDelayMs?: number;
}

// The admin password is stored only as a scrypt hash in the data directory.
// Until one exists, the first visitor must present a one-time setup code that
// node-runner writes to the same directory and its log, so whoever reaches the
// page first cannot claim it. Deleting the hash resets the password.
export class Auth {
    private readonly dataDir: string;
    private readonly log: (message: string) => void;
    private readonly now: () => number;
    private readonly failureDelayMs: number;
    private readonly sessions = new Map<string, number>();
    private readonly revocations = new EventEmitter();

    constructor(options: AuthOptions) {
        this.dataDir = options.dataDir;
        this.log = options.log ?? (message => console.log(message));
        this.now = options.now ?? Date.now;
        this.failureDelayMs = options.failureDelayMs ?? 1000;
    }

    private get passwordPath(): string {
        return join(this.dataDir, PASSWORD_FILE);
    }

    private get setupCodePath(): string {
        return join(this.dataDir, SETUP_CODE_FILE);
    }

    async isConfigured(): Promise<boolean> {
        return (await readOptional(this.passwordPath)) !== null;
    }

    // Called at startup and whenever the setup page is shown, so deleting the
    // password hash brings back setup without a restart. An existing code is
    // kept, so a restart does not invalidate the one the installer printed.
    // Once unconfigured, every session ends: a reset logs everyone out.
    async ensureSetupCode(announce = false): Promise<string | null> {
        if (await this.isConfigured()) {
            return null;
        }
        if (this.sessions.size) {
            this.sessions.clear();
            this.revocations.emit('revoke', null);
        }
        let code = (await readOptional(this.setupCodePath))?.trim();
        if (!code) {
            code = generateSetupCode();
            await fs.mkdir(this.dataDir, { recursive: true });
            await fs.writeFile(this.setupCodePath, `${code}\n`, { mode: 0o600 });
            announce = true;
        }
        if (announce) {
            this.log(`node-runner is not set up yet. Setup code: ${code} (also in ${this.setupCodePath})`);
        }
        return code;
    }

    async setup(code: string, password: string): Promise<string> {
        if (await this.isConfigured()) {
            throw new AuthError('node-runner is already set up', 409);
        }
        const stored = (await readOptional(this.setupCodePath))?.trim();
        const given = canonicalCode(code || '');
        const expected = stored ? canonicalCode(stored) : null;
        if (!expected || given.length !== expected.length || !timingSafeEqual(given, expected)) {
            await sleep(this.failureDelayMs);
            throw new AuthError('The setup code is not correct', 401);
        }
        if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
            throw new AuthError(`The password must be at least ${MIN_PASSWORD_LENGTH} characters`, 400);
        }
        // Created exclusively: of two setups racing with the same code, only
        // the first to write sets the password.
        try {
            await fs.writeFile(this.passwordPath, `${await hashPassword(password)}\n`, { mode: 0o600, flag: 'wx' });
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
                throw new AuthError('node-runner is already set up', 409);
            }
            throw error;
        }
        await fs.rm(this.setupCodePath, { force: true });
        return this.createSession();
    }

    async login(password: string): Promise<string> {
        const stored = await readOptional(this.passwordPath);
        if (stored === null) {
            throw new AuthError('node-runner is not set up yet', 409);
        }
        if (typeof password !== 'string' || !(await verifyPassword(password, stored))) {
            await sleep(this.failureDelayMs);
            throw new AuthError('The password is not correct', 401);
        }
        return this.createSession();
    }

    private createSession(): string {
        const token = randomBytes(32).toString('hex');
        this.sessions.set(token, this.now() + SESSION_TTL_MS);
        return token;
    }

    // Sessions slide: each authenticated request extends the expiry.
    checkSession(token: string | undefined): boolean {
        if (!token) {
            return false;
        }
        const expires = this.sessions.get(token);
        if (expires === undefined) {
            return false;
        }
        if (expires <= this.now()) {
            this.sessions.delete(token);
            return false;
        }
        this.sessions.set(token, this.now() + SESSION_TTL_MS);
        return true;
    }

    // Whether a session is still valid, without extending it: long-lived
    // streams recheck access this way so they do not keep an idle session alive.
    peekSession(token: string | undefined): boolean {
        const expires = token ? this.sessions.get(token) : undefined;
        return expires !== undefined && expires > this.now();
    }

    logout(token: string | undefined): void {
        if (token && this.sessions.delete(token)) {
            this.revocations.emit('revoke', token);
        }
    }

    // Called with the ended session's token, or null when every session ended.
    onRevoke(listener: (token: string | null) => void): () => void {
        this.revocations.on('revoke', listener);
        return () => this.revocations.off('revoke', listener);
    }
}

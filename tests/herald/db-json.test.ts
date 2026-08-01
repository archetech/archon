import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { DbJson } from '../../services/herald/server/src/db/json';
import type { ReplyToken } from '../../services/herald/server/src/db/interfaces';

let tmpDir: string;
let dbPath: string;

function replyToken(token: string, createdAt: string): ReplyToken {
    return {
        token,
        originalDmailDid: 'did:cid:dmail',
        senderDid: 'did:cid:alice',
        senderName: 'Alice',
        emailRecipient: 'someone@example.com',
        createdAt,
    };
}

// init() logs when it creates the directory; silence it for the common setup path.
async function freshDb() {
    const db = new DbJson(dbPath);
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    await db.init();
    log.mockRestore();
    return db;
}

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-db-'));
    dbPath = path.join(tmpDir, 'nested', 'db.json');
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('DbJson.init', () => {
    it('creates the containing directory when missing', async () => {
        const log = jest.spyOn(console, 'log').mockImplementation(() => {});
        try {
            expect(fs.existsSync(path.dirname(dbPath))).toBe(false);

            await new DbJson(dbPath).init();

            expect(fs.existsSync(path.dirname(dbPath))).toBe(true);
        } finally {
            log.mockRestore();
        }
    });

    it('is a no-op when the directory already exists', async () => {
        const db = new DbJson(path.join(tmpDir, 'db.json'));

        await expect(db.init()).resolves.toBeUndefined();
        expect(fs.existsSync(tmpDir)).toBe(true);
    });
});

describe('DbJson users', () => {
    it('returns null before anything is written', async () => {
        const db = await freshDb();

        await expect(db.getUser('did:cid:alice')).resolves.toBeNull();
        await expect(db.listUsers()).resolves.toEqual({});
    });

    it('round-trips a user through the file', async () => {
        const db = await freshDb();

        await db.setUser('did:cid:alice', { name: 'Alice', logins: 1 });

        await expect(db.getUser('did:cid:alice')).resolves.toEqual({ name: 'Alice', logins: 1 });
        // A second instance reads the same file, proving it persisted.
        await expect(new DbJson(dbPath).getUser('did:cid:alice')).resolves.toEqual({
            name: 'Alice',
            logins: 1,
        });
    });

    it('deletes a user and reports whether one was removed', async () => {
        const db = await freshDb();
        await db.setUser('did:cid:alice', { name: 'Alice' });

        await expect(db.deleteUser('did:cid:alice')).resolves.toBe(true);
        await expect(db.getUser('did:cid:alice')).resolves.toBeNull();
        await expect(db.deleteUser('did:cid:alice')).resolves.toBe(false);
        await expect(db.deleteUser('did:cid:never')).resolves.toBe(false);
    });

    it('finds a DID by name, ignoring case and surrounding whitespace', async () => {
        const db = await freshDb();
        await db.setUser('did:cid:alice', { name: '  Alice  ' });
        await db.setUser('did:cid:bob', { name: 'Bob' });

        await expect(db.findDidByName('alice')).resolves.toBe('did:cid:alice');
        await expect(db.findDidByName('  ALICE ')).resolves.toBe('did:cid:alice');
        await expect(db.findDidByName('Bob')).resolves.toBe('did:cid:bob');
        await expect(db.findDidByName('carol')).resolves.toBeNull();
    });

    it('skips users with no name when searching by name', async () => {
        const db = await freshDb();
        await db.setUser('did:cid:anon', { logins: 2 });

        await expect(db.findDidByName('anon')).resolves.toBeNull();
    });
});

describe('DbJson reply tokens', () => {
    it('round-trips a reply token', async () => {
        const db = await freshDb();
        const token = replyToken('abc', new Date().toISOString());

        await db.setReplyToken('abc', token);

        await expect(db.getReplyToken('abc')).resolves.toEqual(token);
        await expect(db.getReplyToken('missing')).resolves.toBeNull();
    });

    it('deletes only tokens older than the supplied age', async () => {
        const db = await freshDb();
        const now = Date.now();
        await db.setReplyToken('fresh', replyToken('fresh', new Date(now - 1000).toISOString()));
        await db.setReplyToken('stale', replyToken('stale', new Date(now - 100_000).toISOString()));

        await expect(db.deleteExpiredReplyTokens(50_000)).resolves.toBe(1);
        await expect(db.getReplyToken('fresh')).resolves.not.toBeNull();
        await expect(db.getReplyToken('stale')).resolves.toBeNull();
    });

    it('reports zero when there is nothing to prune', async () => {
        const db = await freshDb();

        await expect(db.deleteExpiredReplyTokens(1000)).resolves.toBe(0);

        await db.setReplyToken('fresh', replyToken('fresh', new Date().toISOString()));
        await expect(db.deleteExpiredReplyTokens(60_000)).resolves.toBe(0);
    });
});

describe('DbJson email mappings', () => {
    it('round-trips an email mapping', async () => {
        const db = new DbJson(path.join(tmpDir, 'db.json'));
        const mapping = {
            dmailDid: 'did:cid:dmail',
            emailAddress: 'someone@example.com',
            recipientDid: 'did:cid:bob',
            createdAt: new Date().toISOString(),
        };

        await db.setEmailMapping('did:cid:dmail', mapping);

        await expect(db.getEmailMapping('did:cid:dmail')).resolves.toEqual(mapping);
        await expect(db.getEmailMapping('did:cid:none')).resolves.toBeNull();
    });
});

describe('DbJson corrupt or unwritable files', () => {
    it('treats an unparsable file as empty and logs the error', async () => {
        const corrupt = path.join(tmpDir, 'corrupt.json');
        fs.writeFileSync(corrupt, '{ not valid json');
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});

        try {
            const db = new DbJson(corrupt);

            await expect(db.listUsers()).resolves.toEqual({});
            await expect(db.getUser('did:cid:alice')).resolves.toBeNull();
            expect(error).toHaveBeenCalled();
        } finally {
            error.mockRestore();
        }
    });

    it('swallows a write failure and logs it rather than throwing', async () => {
        // Path points through a file, so the write cannot succeed.
        const blocker = path.join(tmpDir, 'a-file');
        fs.writeFileSync(blocker, 'x');
        const db = new DbJson(path.join(blocker, 'db.json'));
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});

        try {
            await expect(db.setUser('did:cid:alice', { name: 'Alice' })).resolves.toBeUndefined();
            expect(error).toHaveBeenCalled();
        } finally {
            error.mockRestore();
        }
    });
});

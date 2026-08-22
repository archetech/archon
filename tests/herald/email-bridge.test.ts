import { jest } from '@jest/globals';

import { EmailBridge } from '../../services/herald/server/src/email-bridge.ts';
import type {
    DatabaseInterface,
    EmailMapping,
    ReplyToken,
} from '../../services/herald/server/src/db/interfaces.ts';
import type { EmailServiceInterface } from '../../services/herald/server/src/email/interfaces.ts';

const config = {
    domain: 'archon.test',
    parseDomain: 'parse.archon.test',
    fromEmail: 'noreply@archon.test',
    fromName: 'Archon',
};

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function createBridge(overrides: {
    db?: Partial<DatabaseInterface>;
    email?: Partial<EmailServiceInterface>;
} = {}) {
    const db = {
        setReplyToken: jest.fn<any>().mockResolvedValue(undefined),
        getReplyToken: jest.fn<any>().mockResolvedValue(null),
        deleteExpiredReplyTokens: jest.fn<any>().mockResolvedValue(0),
        setEmailMapping: jest.fn<any>().mockResolvedValue(undefined),
        getEmailMapping: jest.fn<any>().mockResolvedValue(null),
        ...overrides.db,
    } as unknown as DatabaseInterface;

    const emailService = {
        sendMail: jest.fn<any>().mockResolvedValue(undefined),
        isConfigured: jest.fn<any>().mockReturnValue(true),
        ...overrides.email,
    } as unknown as EmailServiceInterface;

    return { bridge: new EmailBridge(config, db, emailService), db, emailService };
}

describe('EmailBridge.sendEmail', () => {
    let log: any;

    beforeEach(() => {
        log = jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        log.mockRestore();
    });

    it('mints a reply token, persists it, and threads it through the reply-to address', async () => {
        const { bridge, db, emailService } = createBridge();

        const { token } = await bridge.sendEmail({
            to: 'someone@example.com',
            subject: 'Hello',
            body: 'Body text',
            senderName: 'Alice',
            senderDid: 'did:cid:alice',
            dmailDid: 'did:cid:dmail',
        });

        expect(token).toMatch(/^[0-9a-f]{32}$/);
        expect(db.setReplyToken).toHaveBeenCalledWith(token, expect.objectContaining({
            token,
            originalDmailDid: 'did:cid:dmail',
            senderDid: 'did:cid:alice',
            senderName: 'Alice',
            emailRecipient: 'someone@example.com',
        }));

        expect(emailService.sendMail).toHaveBeenCalledWith(expect.objectContaining({
            to: 'someone@example.com',
            from: { email: 'noreply@archon.test', name: 'Alice via Archon' },
            replyTo: { email: `reply+${token}@parse.archon.test`, name: 'Alice' },
            subject: 'Hello',
            text: 'Body text',
        }));
    });

    it('honours an explicit fromEmail override', async () => {
        const { bridge, emailService } = createBridge();

        await bridge.sendEmail({
            to: 'someone@example.com',
            subject: 'Hi',
            body: 'Body',
            senderName: 'Alice',
            senderDid: 'did:cid:alice',
            dmailDid: 'did:cid:dmail',
            fromEmail: 'custom@archon.test',
        });

        expect((emailService.sendMail as any).mock.calls[0][0].from.email).toBe('custom@archon.test');
    });

    it('issues a distinct token per send', async () => {
        const { bridge } = createBridge();
        const params = {
            to: 'someone@example.com',
            subject: 'Hi',
            body: 'Body',
            senderName: 'Alice',
            senderDid: 'did:cid:alice',
            dmailDid: 'did:cid:dmail',
        };

        const first = await bridge.sendEmail(params);
        const second = await bridge.sendEmail(params);

        expect(first.token).not.toBe(second.token);
    });

    it('prunes expired tokens using the 30-day TTL after sending', async () => {
        const { bridge, db } = createBridge({
            db: { deleteExpiredReplyTokens: jest.fn<any>().mockResolvedValue(3) },
        });

        await bridge.sendEmail({
            to: 'someone@example.com',
            subject: 'Hi',
            body: 'Body',
            senderName: 'Alice',
            senderDid: 'did:cid:alice',
            dmailDid: 'did:cid:dmail',
        });

        expect(db.deleteExpiredReplyTokens).toHaveBeenCalledWith(THIRTY_DAYS_MS);
    });
});

describe('EmailBridge.parseInboundEmail', () => {
    const { bridge } = createBridge();

    it('requires both from and to', () => {
        expect(bridge.parseInboundEmail({})).toBeNull();
        expect(bridge.parseInboundEmail({ from: 'a@b.com' })).toBeNull();
        expect(bridge.parseInboundEmail({ to: 'a@b.com' })).toBeNull();
    });

    it('defaults the subject and text when absent', () => {
        const parsed = bridge.parseInboundEmail({ from: 'a@b.com', to: 'c@d.com' });

        expect(parsed).toMatchObject({
            from: 'a@b.com',
            to: 'c@d.com',
            subject: '(no subject)',
            text: '',
        });
    });

    it('carries through the spam and auth metadata', () => {
        const parsed = bridge.parseInboundEmail({
            from: 'a@b.com',
            to: 'c@d.com',
            subject: 'Re: hello',
            text: 'body',
            html: '<p>body</p>',
            SPF: 'pass',
            dkim: 'pass',
            spam_score: '0.1',
            spam_report: 'clean',
            headers: 'X-Test: 1',
            envelope: '{}',
        });

        expect(parsed).toMatchObject({
            subject: 'Re: hello',
            html: '<p>body</p>',
            SPF: 'pass',
            dkim: 'pass',
            spam_score: '0.1',
            spam_report: 'clean',
        });
    });
});

describe('EmailBridge address parsing', () => {
    const { bridge } = createBridge();

    it('extracts a reply token from a reply+ address', () => {
        expect(bridge.extractReplyToken('reply+deadbeef01@parse.archon.test')).toBe('deadbeef01');
        expect(bridge.extractReplyToken('Name <reply+abc123@parse.archon.test>')).toBe('abc123');
        expect(bridge.extractReplyToken('REPLY+ABCDEF@parse.archon.test')).toBe('ABCDEF');
    });

    it('returns null when there is no reply token', () => {
        expect(bridge.extractReplyToken('someone@example.com')).toBeNull();
        expect(bridge.extractReplyToken('reply+@parse.archon.test')).toBeNull();
        expect(bridge.extractReplyToken('reply+zzz@parse.archon.test')).toBeNull();
    });

    it('extracts and lowercases a bare address from a display-name header', () => {
        expect(bridge.extractEmailAddress('Alice <Alice@Example.COM>')).toBe('alice@example.com');
        expect(bridge.extractEmailAddress('bob@example.com')).toBe('bob@example.com');
        expect(bridge.extractEmailAddress('  < spaced@example.com >')).toBe('spaced@example.com');
    });

    it('returns null when no address is present', () => {
        expect(bridge.extractEmailAddress('no address here')).toBeNull();
        expect(bridge.extractEmailAddress('')).toBeNull();
    });

    it('extracts the local part as a recipient name', () => {
        expect(bridge.extractRecipientName('alice@archon.test')).toBe('alice');
        expect(bridge.extractRecipientName('Alice <Alice@archon.test>')).toBe('alice');
    });

    it('ignores reply and system addresses', () => {
        expect(bridge.extractRecipientName('reply+abc@parse.archon.test')).toBeNull();
        expect(bridge.extractRecipientName('postmaster@archon.test')).toBeNull();
        expect(bridge.extractRecipientName('abuse@archon.test')).toBeNull();
        expect(bridge.extractRecipientName('noreply@archon.test')).toBeNull();
        expect(bridge.extractRecipientName('mailer-daemon@archon.test')).toBeNull();
    });

    it('returns null when there is no local part', () => {
        expect(bridge.extractRecipientName('not-an-address')).toBeNull();
    });
});

describe('EmailBridge lookups and mappings', () => {
    it('prunes expired tokens before looking one up', async () => {
        const stored: ReplyToken = {
            token: 'abc',
            originalDmailDid: 'did:cid:dmail',
            senderDid: 'did:cid:alice',
            senderName: 'Alice',
            emailRecipient: 'someone@example.com',
            createdAt: new Date().toISOString(),
        };
        const { bridge, db } = createBridge({
            db: { getReplyToken: jest.fn<any>().mockResolvedValue(stored) },
        });

        await expect(bridge.lookupToken('abc')).resolves.toEqual(stored);
        expect(db.deleteExpiredReplyTokens).toHaveBeenCalledWith(THIRTY_DAYS_MS);
        expect(db.getReplyToken).toHaveBeenCalledWith('abc');
    });

    it('returns null for an unknown token', async () => {
        const { bridge } = createBridge();

        await expect(bridge.lookupToken('missing')).resolves.toBeNull();
    });

    it('stores and reads back an email mapping', async () => {
        const mapping: EmailMapping = {
            dmailDid: 'did:cid:dmail',
            emailAddress: 'someone@example.com',
            recipientDid: 'did:cid:bob',
            createdAt: new Date().toISOString(),
        };
        const { bridge, db } = createBridge({
            db: { getEmailMapping: jest.fn<any>().mockResolvedValue(mapping) },
        });

        await bridge.storeEmailMapping('did:cid:dmail', 'someone@example.com', 'did:cid:bob');
        expect(db.setEmailMapping).toHaveBeenCalledWith('did:cid:dmail', expect.objectContaining({
            dmailDid: 'did:cid:dmail',
            emailAddress: 'someone@example.com',
            recipientDid: 'did:cid:bob',
        }));

        await expect(bridge.lookupEmailMapping('did:cid:dmail')).resolves.toEqual(mapping);
    });
});

describe('EmailBridge configuration accessors', () => {
    it('exposes the configured domains and sender identity', () => {
        const { bridge } = createBridge();

        expect(bridge.parseDomain).toBe('parse.archon.test');
        expect(bridge.fromEmail).toBe('noreply@archon.test');
        expect(bridge.fromName).toBe('Archon');
    });

    it('delegates isConfigured to the email service', () => {
        const configured = createBridge();
        expect(configured.bridge.isConfigured()).toBe(true);

        const unconfigured = createBridge({
            email: { isConfigured: jest.fn<any>().mockReturnValue(false) },
        });
        expect(unconfigured.bridge.isConfigured()).toBe(false);
    });
});

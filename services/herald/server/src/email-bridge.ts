import crypto from 'crypto';
import sgMail from '@sendgrid/mail';
import { DatabaseInterface, ReplyToken, EmailMapping } from './db/interfaces.js';

export type { ReplyToken, EmailMapping };

interface InboundEmail {
    from: string;
    to: string;
    subject: string;
    text: string;
    html?: string;
    headers?: string;
    envelope?: string;
    SPF?: string;
    dkim?: string;
    spam_score?: string;
    spam_report?: string;
}

interface EmailBridgeConfig {
    sendgridApiKey: string;
    domain: string;
    parseDomain: string;
    fromEmail: string;
    fromName: string;
}

export class EmailBridge {
    private config: EmailBridgeConfig;
    private db: DatabaseInterface;
    private tokenTTLMs = 30 * 24 * 60 * 60 * 1000; // 30 days

    constructor(config: EmailBridgeConfig, db: DatabaseInterface) {
        this.config = config;
        this.db = db;
        sgMail.setApiKey(config.sendgridApiKey);
    }

    private generateToken(): string {
        return crypto.randomBytes(16).toString('hex');
    }

    async sendEmail(params: {
        to: string;
        subject: string;
        body: string;
        senderName: string;
        senderDid: string;
        dmailDid: string;
        fromEmail?: string;
    }): Promise<{ token: string }> {
        const token = this.generateToken();

        await this.db.setReplyToken(token, {
            token,
            originalDmailDid: params.dmailDid,
            senderDid: params.senderDid,
            senderName: params.senderName,
            emailRecipient: params.to,
            createdAt: new Date().toISOString(),
        });

        const replyTo = `reply+${token}@${this.config.parseDomain}`;

        const msg = {
            to: params.to,
            from: {
                email: params.fromEmail || this.config.fromEmail,
                name: `${params.senderName} via ${this.config.fromName}`,
            },
            replyTo: {
                email: replyTo,
                name: params.senderName,
            },
            subject: params.subject,
            text: params.body,
        };

        await sgMail.send(msg);
        console.log(`Email sent to ${params.to} from ${params.senderName} (token: ${token.slice(0, 8)}...)`);

        // Clean up expired tokens periodically
        const cleaned = await this.db.deleteExpiredReplyTokens(this.tokenTTLMs);
        if (cleaned > 0) console.log(`Cleaned ${cleaned} expired reply tokens`);

        return { token };
    }

    parseInboundEmail(body: Record<string, string>): InboundEmail | null {
        if (!body.from || !body.to) {
            return null;
        }
        return {
            from: body.from,
            to: body.to,
            subject: body.subject || '(no subject)',
            text: body.text || '',
            html: body.html,
            headers: body.headers,
            envelope: body.envelope,
            SPF: body.SPF,
            dkim: body.dkim,
            spam_score: body.spam_score,
            spam_report: body.spam_report,
        };
    }

    extractReplyToken(toAddress: string): string | null {
        // Match reply+<token>@parse.domain.com
        const match = toAddress.match(/reply\+([a-f0-9]+)@/i);
        return match ? match[1] : null;
    }

    extractEmailAddress(headerValue: string): string | null {
        // Extract bare email from "Name <user@domain>" or "user@domain"
        const match = headerValue.match(/<\s*([^>\s]+@[^>\s]+)\s*>/) || headerValue.match(/([^\s<]+@[^\s>,]+)/);
        return match ? match[1].toLowerCase() : null;
    }

    extractRecipientName(toAddress: string): string | null {
        // Extract local part from "Name <user@domain>" or "user@domain"
        const emailMatch = toAddress.match(/<?\s*([^@<\s]+)@/);
        if (!emailMatch) return null;
        const localPart = emailMatch[1].toLowerCase();
        // Ignore reply+ addresses and common system addresses
        if (localPart.startsWith('reply+') || ['postmaster', 'abuse', 'noreply', 'mailer-daemon'].includes(localPart)) {
            return null;
        }
        return localPart;
    }

    async lookupToken(token: string): Promise<ReplyToken | null> {
        await this.db.deleteExpiredReplyTokens(this.tokenTTLMs);
        return this.db.getReplyToken(token);
    }

    async storeEmailMapping(dmailDid: string, emailAddress: string, recipientDid: string): Promise<void> {
        await this.db.setEmailMapping(dmailDid, {
            dmailDid,
            emailAddress,
            recipientDid,
            createdAt: new Date().toISOString(),
        });
    }

    async lookupEmailMapping(dmailDid: string): Promise<EmailMapping | null> {
        return this.db.getEmailMapping(dmailDid);
    }

    get parseDomain(): string {
        return this.config.parseDomain;
    }

    get fromEmail(): string {
        return this.config.fromEmail;
    }

    get fromName(): string {
        return this.config.fromName;
    }

    isConfigured(): boolean {
        return !!this.config.sendgridApiKey;
    }
}

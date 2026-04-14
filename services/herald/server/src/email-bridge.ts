import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import sgMail from '@sendgrid/mail';

interface ReplyToken {
    originalDmailDid: string;
    senderDid: string;
    senderName: string;
    emailRecipient: string;
    createdAt: string;
}

interface ReplyTokenStore {
    tokens: Record<string, ReplyToken>;
}

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
    dataDir: string;
}

export class EmailBridge {
    private config: EmailBridgeConfig;
    private tokenStorePath: string;
    private tokenStore: ReplyTokenStore = { tokens: {} };
    private tokenTTLMs = 30 * 24 * 60 * 60 * 1000; // 30 days

    constructor(config: EmailBridgeConfig) {
        this.config = config;
        this.tokenStorePath = path.join(config.dataDir, 'reply-tokens.json');
        sgMail.setApiKey(config.sendgridApiKey);
        this.loadTokens();
    }

    private loadTokens(): void {
        try {
            if (fs.existsSync(this.tokenStorePath)) {
                const data = fs.readFileSync(this.tokenStorePath, 'utf-8');
                this.tokenStore = JSON.parse(data);
            }
        } catch (err) {
            console.error('Failed to load reply tokens:', err);
            this.tokenStore = { tokens: {} };
        }
    }

    private saveTokens(): void {
        try {
            fs.writeFileSync(this.tokenStorePath, JSON.stringify(this.tokenStore, null, 2));
        } catch (err) {
            console.error('Failed to save reply tokens:', err);
        }
    }

    private generateToken(): string {
        return crypto.randomBytes(16).toString('hex');
    }

    private cleanExpiredTokens(): void {
        const now = Date.now();
        let cleaned = 0;
        for (const [token, data] of Object.entries(this.tokenStore.tokens)) {
            if (now - new Date(data.createdAt).getTime() > this.tokenTTLMs) {
                delete this.tokenStore.tokens[token];
                cleaned++;
            }
        }
        if (cleaned > 0) {
            this.saveTokens();
            console.log(`Cleaned ${cleaned} expired reply tokens`);
        }
    }

    async sendEmail(params: {
        to: string;
        subject: string;
        body: string;
        senderName: string;
        senderDid: string;
        dmailDid: string;
    }): Promise<{ token: string }> {
        const token = this.generateToken();

        this.tokenStore.tokens[token] = {
            originalDmailDid: params.dmailDid,
            senderDid: params.senderDid,
            senderName: params.senderName,
            emailRecipient: params.to,
            createdAt: new Date().toISOString(),
        };
        this.saveTokens();

        const replyTo = `reply+${token}@${this.config.parseDomain}`;

        const msg = {
            to: params.to,
            from: {
                email: this.config.fromEmail,
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

    lookupToken(token: string): ReplyToken | null {
        this.cleanExpiredTokens();
        return this.tokenStore.tokens[token] || null;
    }

    isConfigured(): boolean {
        return !!this.config.sendgridApiKey;
    }
}

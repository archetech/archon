import sgMail from '@sendgrid/mail';
import { EmailServiceInterface, SendMailParams } from './interfaces.js';

export class SendGridEmailService implements EmailServiceInterface {
    private apiKey: string;

    constructor(apiKey: string) {
        this.apiKey = apiKey;
        if (apiKey) {
            sgMail.setApiKey(apiKey);
        }
    }

    async sendMail(params: SendMailParams): Promise<void> {
        await sgMail.send({
            to: params.to,
            from: params.from,
            replyTo: params.replyTo,
            subject: params.subject,
            text: params.text,
        });
    }

    isConfigured(): boolean {
        return !!this.apiKey;
    }
}

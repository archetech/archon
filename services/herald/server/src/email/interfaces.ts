export interface SendMailParams {
    to: string;
    from: { email: string; name: string };
    replyTo: { email: string; name: string };
    subject: string;
    text: string;
}

export interface EmailServiceInterface {
    sendMail(params: SendMailParams): Promise<void>;
    isConfigured(): boolean;
}

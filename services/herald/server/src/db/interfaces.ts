export interface User {
    firstLogin?: string;
    lastLogin?: string;
    logins?: number;
    name?: string;
    credentialDid?: string;
    credentialIssuedAt?: string;
    [key: string]: any;
}

export interface ReplyToken {
    token: string;
    originalDmailDid: string;
    senderDid: string;
    senderName: string;
    emailRecipient: string;
    createdAt: string;
}

export interface EmailMapping {
    dmailDid: string;
    emailAddress: string;
    recipientDid: string;
    createdAt: string;
}

export interface DatabaseStructure {
    users?: Record<string, User>;
    replyTokens?: Record<string, ReplyToken>;
    emailMappings?: Record<string, EmailMapping>;
}

export interface DatabaseInterface {
    init?(): Promise<void>;
    close?(): Promise<void>;
    getUser(did: string): Promise<User | null>;
    setUser(did: string, user: User): Promise<void>;
    deleteUser(did: string): Promise<boolean>;
    listUsers(): Promise<Record<string, User>>;
    findDidByName(name: string): Promise<string | null>;

    // Email bridge
    setReplyToken(token: string, data: ReplyToken): Promise<void>;
    getReplyToken(token: string): Promise<ReplyToken | null>;
    deleteExpiredReplyTokens(maxAgeMs: number): Promise<number>;
    setEmailMapping(dmailDid: string, mapping: EmailMapping): Promise<void>;
    getEmailMapping(dmailDid: string): Promise<EmailMapping | null>;
}

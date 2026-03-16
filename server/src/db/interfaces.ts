export interface User {
    firstLogin?: string;
    lastLogin?: string;
    logins?: number;
    name?: string;
    credentialDid?: string;
    credentialName?: string;  // The name at time of credential issuance
    credentialIssuedAt?: string;
    [key: string]: any;
}

export interface DatabaseStructure {
    users?: Record<string, User>;
}

export interface DatabaseInterface {
    init?(): void;
    loadDb(): DatabaseStructure;
    writeDb(data: DatabaseStructure): void;
}

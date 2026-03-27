export interface User {
    firstLogin?: string;
    lastLogin?: string;
    logins?: number;
    name?: string;
    credentialDid?: string;
    credentialIssuedAt?: string;
    [key: string]: any;
}

export interface DatabaseStructure {
    users?: Record<string, User>;
}

export interface DatabaseInterface {
    init?(): Promise<void>;
    close?(): Promise<void>;
    getUser(did: string): Promise<User | null>;
    setUser(did: string, user: User): Promise<void>;
    deleteUser(did: string): Promise<boolean>;
    listUsers(): Promise<Record<string, User>>;
    findDidByName(name: string): Promise<string | null>;
}

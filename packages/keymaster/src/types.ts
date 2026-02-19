import { Cipher, EcdsaJwkPublic } from '@didcid/cipher/types';
import {
    GatekeeperInterface,
    DidCidDocument,
    ResolveDIDOptions,
    Proof,
} from '@didcid/gatekeeper/types';

export interface Seed {
    /** Passphrase-encrypted mnemonic */
    mnemonicEnc?: {
        salt: string;
        iv: string;
        data: string;
    };
}

export interface IDInfo {
    did: string;
    account: number;
    index: number;
    held?: string[];
    owned?: string[];
    dmail?: Record<string, any>;
    notices?: Record<string, any>;
    [key: string]: any; // Allow custom metadata fields
}

export interface WalletEncFile {
    version: number;
    seed: Seed;
    enc: string
}

export interface WalletFile {
    version?: number;
    seed: Seed;
    counter: number;
    ids: Record<string, IDInfo>;
    current?: string;
    aliases?: Record<string, string>;
    [key: string]: any; // Allow custom metadata fields
}

export interface CheckWalletResult {
    checked: number;
    invalid: number;
    deleted: number;
}

export interface FixWalletResult {
    idsRemoved: number;
    ownedRemoved: number;
    heldRemoved: number;
    aliasesRemoved: number;
}

export interface CreateAssetOptions {
    registry?: string;
    controller?: string;
    validUntil?: string;
    alias?: string;
}

export interface FileAssetOptions extends CreateAssetOptions {
    filename?: string;
}

export interface EncryptOptions extends CreateAssetOptions {
    encryptForSender?: boolean;
    includeHash?: boolean;
}

export interface Group {
    name: string;
    members: string[];
}

export interface CredentialSchema {
    id: string;
    type: "JsonSchema";
}

export interface VerifiableCredential {
    "@context": string[];
    type: string[];
    issuer: string;
    validFrom: string;
    validUntil?: string;
    credentialSchema?: CredentialSchema;
    credentialSubject?: {
        id: string;
        [key: string]: unknown;
    };
    proof?: Proof;
}

export interface IssueCredentialsOptions extends EncryptOptions {
    schema?: string;
    subject?: string;
    validFrom?: string;
    claims?: Record<string, unknown>;
}

export interface Challenge {
    credentials?: {
        schema: string;
        issuers?: string[];
    }[];
    [key: string]: any;
}

export interface ChallengeResponse {
    challenge: string;
    credentials: {
        vc: string;
        vp: string;
    }[];
    requested: number;
    fulfilled: number;
    match: boolean;
    vps?: unknown[];
    responder?: string;
}

export interface CreateResponseOptions {
    registry?: string;
    validUntil?: string;
    retries?: number;
    delay?: number;
}

export interface PollResults {
    tally: Array<{
        vote: number;
        option: string;
        count: number;
    }>;
    ballots?: Array<{
        voter: string;
        vote: number;
        option: string;
        received: string;
    }>;
    votes?: {
        eligible: number;
        received: number;
        pending: number;
    };
    final?: boolean;
}

export interface PollConfig {
    version: 2;
    description: string;
    options: string[];
    deadline: string;
}

export interface ViewPollResult {
    description: string;
    options: string[];
    deadline: string;
    isOwner: boolean;
    isEligible: boolean;
    voteExpired: boolean;
    hasVoted: boolean;
    voters?: string[];
    results?: PollResults;
}

export interface ViewBallotResult {
    poll: string;
    voter?: string;
    vote?: number;
    option?: string;
}

export interface BinaryAsset {
    cid: string;
    type: string;
    bytes: number;
    data?: Buffer;
}

export interface ImageAsset {
    width: number;
    height: number;
}

export interface FileAsset extends BinaryAsset {
    filename: string;
}

export interface ImageFileAsset {
    file: FileAsset;
    image: ImageAsset;
}

export interface Vault {
    version?: number;
    publicJwk: EcdsaJwkPublic;
    salt: string;
    config: string;
    members: string;
    keys: Record<string, string>;
    items: string,
    sha256: string,
}

export interface VaultOptions extends CreateAssetOptions {
    secretMembers?: boolean;
    version?: number;
}

export interface VaultLogin {
    service: string;
    username: string;
    password: string;
}

export type StoredWallet = WalletFile | WalletEncFile | null;

export interface WalletBase {
    saveWallet(wallet: StoredWallet, overwrite?: boolean): Promise<boolean>;
    loadWallet(): Promise<StoredWallet | null>;
    updateWallet(mutator: (wallet: StoredWallet) => void | Promise<void>): Promise<void>;
}

export interface KeymasterOptions {
    passphrase: string;
    gatekeeper: GatekeeperInterface;
    wallet: WalletBase;
    cipher: Cipher;
    defaultRegistry?: string;
    maxAliasLength?: number;
}

export interface EncryptedMessage {
    sender?: string;
    created?: string;
    cipher_hash?: string | null;
    cipher_sender?: string | null;
    cipher_receiver?: string | null;
}

export interface PossiblyProofed {
    proof?: Proof;
}

export interface RestClientOptions {
    url?: string;
    console?: any;
    waitUntilReady?: boolean;
    intervalSeconds?: number;
    chatty?: boolean;
    becomeChattyAfter?: number;
    maxRetries?: number;
}

export interface KeymasterClientOptions extends RestClientOptions {
}
export interface WaitUntilReadyOptions {
    intervalSeconds?: number;
    chatty?: boolean;
    becomeChattyAfter?: number;
    maxRetries?: number;
}

export interface DmailMessage {
    to: string[];
    cc: string[];
    subject: string;
    body: string;
    reference?: string;
}

export interface DmailItem {
    message: DmailMessage;
    to: string[];
    cc: string[];
    sender: string;
    date: string;
    tags: string[];
    attachments?: any;
    docs?: any;
}

export interface NoticeMessage {
    to: string[];
    dids: string[];
}

export interface KeymasterInterface {
    // Wallet
    loadWallet(): Promise<WalletFile>;
    saveWallet(wallet: StoredWallet, overwrite?: boolean): Promise<boolean>;
    newWallet(mnemonic?: string, overwrite?: boolean): Promise<WalletFile>;
    backupWallet(): Promise<boolean | string>;
    recoverWallet(): Promise<WalletFile>;
    checkWallet(): Promise<CheckWalletResult>;
    fixWallet(): Promise<FixWalletResult>;
    decryptMnemonic(): Promise<string>;
    exportEncryptedWallet(): Promise<WalletEncFile>;

    // IDs
    listIds(): Promise<string[]>;
    getCurrentId(): Promise<string | undefined>;
    setCurrentId(name: string): Promise<boolean>;
    createId(name: string, options?: { registry?: string }): Promise<string>;
    removeId(id: string): Promise<boolean>;
    renameId(id: string, newName: string): Promise<boolean>;
    backupId(id?: string): Promise<boolean>;
    recoverId(did: string): Promise<string>;

    // Alias system
    listAliases(): Promise<Record<string, string>>;
    addAlias(alias: string, did: string): Promise<boolean>;
    getAlias(alias: string): Promise<string | null>;
    removeAlias(alias: string): Promise<boolean>;

    // DIDs
    resolveDID(did: string, options?: ResolveDIDOptions): Promise<DidCidDocument>;
    updateDID(id: string, doc: DidCidDocument): Promise<boolean>;

    // Assets
    createAsset(data: unknown, options?: CreateAssetOptions): Promise<string>;
    listAssets(owner?: string): Promise<string[]>;
    resolveAsset(did: string, options?: ResolveDIDOptions): Promise<unknown | null>;
    mergeData(did: string, data: Record<string, unknown>): Promise<boolean>;

    // Encryption
    encryptMessage(msg: string, receiver: string, options?: EncryptOptions): Promise<string>;
    decryptMessage(did: string): Promise<string>;
    encryptJSON(json: unknown, receiver: string, options?: EncryptOptions): Promise<string>;
    decryptJSON(did: string): Promise<unknown>;

    // Groups
    createGroup(name: string, options?: CreateAssetOptions): Promise<string>;
    getGroup(group: string): Promise<Group | null>;
    addGroupMember(group: string, member: string): Promise<boolean>;
    removeGroupMember(group: string, member: string): Promise<boolean>;
    testGroup(group: string, member?: string): Promise<boolean>;
    listGroups(owner?: string): Promise<string[]>;

    // Schemas
    createSchema(schema?: unknown, options?: CreateAssetOptions): Promise<string>;
    getSchema(did: string): Promise<unknown | null>;
    setSchema(did: string, schema: unknown): Promise<boolean>;
    testSchema(did: string): Promise<boolean>;
    listSchemas(owner?: string): Promise<string[]>;

    // Agents
    testAgent(did: string): Promise<boolean>;

    // Credentials
    bindCredential(subject: string, options?: {
        schema?: string;
        validFrom?: string;
        validUntil?: string;
        claims?: Record<string, unknown>;
        types?: string[];
    }): Promise<VerifiableCredential>;

    issueCredential(credential: Partial<VerifiableCredential>, options?: IssueCredentialsOptions): Promise<string>;
    sendCredential(did: string, options?: CreateAssetOptions): Promise<string | null>;
    updateCredential(did: string, credential: VerifiableCredential): Promise<boolean>;
    revokeCredential(did: string): Promise<boolean>;
    listIssued(issuer?: string): Promise<string[]>;
    acceptCredential(did: string): Promise<boolean>;
    getCredential(did: string): Promise<VerifiableCredential | null>;
    removeCredential(did: string): Promise<boolean>;
    listCredentials(id?: string): Promise<string[]>;
    publishCredential(did: string, options?: { reveal?: boolean }): Promise<VerifiableCredential | boolean>;
    unpublishCredential(did: string): Promise<string | boolean>;

    // Challenges
    createChallenge(challenge?: Challenge, options?: { registry?: string; validUntil?: string }): Promise<string>;
    createResponse(challengeDid: string, options?: CreateResponseOptions): Promise<string>;
    verifyResponse(responseDid: string, options?: { retries?: number; delay?: number }): Promise<ChallengeResponse>;

    // Polls
    pollTemplate(): Promise<PollConfig>;
    createPoll(config: PollConfig, options?: VaultOptions): Promise<string>;
    getPoll(pollId: string): Promise<PollConfig | null>;
    testPoll(id: string): Promise<boolean>;
    listPolls(owner?: string): Promise<string[]>;
    viewPoll(pollId: string): Promise<ViewPollResult>;
    votePoll(pollId: string, vote: number, options?: { registry?: string; validUntil?: string }): Promise<string>;
    sendBallot(ballotDid: string, pollId: string): Promise<string>;
    viewBallot(ballotDid: string): Promise<ViewBallotResult>;
    updatePoll(ballot: string): Promise<boolean>;
    publishPoll(pollId: string, options?: { reveal?: boolean }): Promise<boolean>;
    unpublishPoll(pollId: string): Promise<boolean>;
    addPollVoter(pollId: string, memberId: string): Promise<boolean>;
    removePollVoter(pollId: string, memberId: string): Promise<boolean>;
    listPollVoters(pollId: string): Promise<Record<string, any>>;

    // Images
    createImage(data: Buffer, options?: FileAssetOptions): Promise<string>;
    updateImage(did: string, data: Buffer, options?: FileAssetOptions): Promise<boolean>;
    getImage(id: string): Promise<ImageFileAsset | null>;
    testImage(id: string): Promise<boolean>;

    // Files
    createFile(data: Buffer, options?: FileAssetOptions): Promise<string>;
    updateFile(did: string, data: Buffer, options?: FileAssetOptions): Promise<boolean>;
    getFile(id: string): Promise<FileAsset | null>;
    testFile(id: string): Promise<boolean>;

    // Vaults
    createVault(options?: VaultOptions): Promise<string>;
    getVault(vaultId: string, options?: ResolveDIDOptions): Promise<Vault>;
    testVault(vaultId: string, options?: ResolveDIDOptions): Promise<boolean>;
    addVaultMember(vaultId: string, memberId: string): Promise<boolean>;
    removeVaultMember(vaultId: string, memberId: string): Promise<boolean>;
    addVaultItem(vaultId: string, name: string, buffer: Buffer): Promise<boolean>;
    removeVaultItem(vaultId: string, name: string): Promise<boolean>;
    listVaultItems(vaultId: string, options?: ResolveDIDOptions): Promise<Record<string, any>>;
    getVaultItem(vaultId: string, name: string, options?: ResolveDIDOptions): Promise<Buffer | null>;

    // Dmail
    createDmail(message: DmailMessage, options?: CreateAssetOptions): Promise<string>;
    updateDmail(did: string, message: DmailMessage): Promise<boolean>;
    fileDmail(did: string, tags: string[]): Promise<boolean>
    removeDmail(did: string): Promise<boolean>;
    importDmail(did: string): Promise<boolean>;
    getDmailMessage(did: string, options?: ResolveDIDOptions): Promise<DmailMessage | null>;
    listDmail(): Promise<Record<string, DmailItem>>;
    sendDmail(did: string): Promise<string | null>;
    addDmailAttachment(did: string, name: string, buffer: Buffer): Promise<boolean>;
    removeDmailAttachment(did: string, name: string): Promise<boolean>;
    listDmailAttachments(did: string, options?: ResolveDIDOptions): Promise<Record<string, any>>;
    getDmailAttachment(did: string, name: string): Promise<Buffer | null>;

    // Notices
    createNotice(message: NoticeMessage, options: CreateAssetOptions): Promise<string>;
    updateNotice(did: string, message: NoticeMessage): Promise<boolean>;
    refreshNotices(): Promise<boolean>;
}

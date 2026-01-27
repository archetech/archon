import { base64url } from 'multiformats/bases/base64';
import {
    InvalidDIDError,
    InvalidParameterError,
    KeymasterError,
    UnknownIDError
} from '@didcid/common/errors';
import {
    GatekeeperInterface,
    DidCidDocument,
    DocumentMetadata,
    ResolveDIDOptions,
    Operation,
    Proof,
    ProofPurpose,
} from '@didcid/gatekeeper/types';
import {
    CheckWalletResult,
    CreateAssetOptions,
    EncryptedMessage,
    EncryptOptions,
    FixWalletResult,
    IDInfo,
    KeymasterInterface,
    KeymasterOptions,
    NoticeMessage,
    PossiblyProofed,
    StoredWallet,
    WalletBase,
    WalletFile,
    WalletEncFile,
    Seed,
} from '@didcid/keymaster/types';
import {
    isWalletEncFile,
    isWalletFile
} from './db/typeGuards.js';
import {
    Cipher,
    EcdsaJwkPair,
    EcdsaJwkPublic,
} from '@didcid/cipher/types';
import { isValidDID } from '@didcid/ipfs/utils';
import { decMnemonic, encMnemonic } from "./encryption.js";
import { VaultMixin } from "./vault-mixin.js";
import { DmailMixin } from "./dmail-mixin.js";
import { GroupMixin } from "./group-mixin.js";
import { SchemaMixin } from "./schema-mixin.js";
import { DocumentMixin } from "./document-mixin.js";
import { PollMixin } from "./poll-mixin.js";
import { CredentialMixin } from "./credential-mixin.js";
import { NoticeMixin } from "./notice-mixin.js";

function hexToBase64url(hex: string): string {
    const bytes = Buffer.from(hex, 'hex');
    return base64url.baseEncode(bytes);
}

function base64urlToHex(b64: string): string {
    const bytes = base64url.baseDecode(b64);
    return Buffer.from(bytes).toString('hex');
}

// DmailTags is exported from dmail-mixin.ts
// NoticeTags is exported from notice-mixin.ts
// DefaultSchema is in schema-mixin.ts

// Base class with core functionality that mixins depend on
class KeymasterBase {
    protected readonly passphrase: string;
    gatekeeper: GatekeeperInterface;
    protected db: WalletBase;
    cipher: Cipher;
    protected readonly defaultRegistry: string;
    readonly ephemeralRegistry: string;
    maxNameLength: number;
    maxDataLength: number;
    protected _walletCache?: WalletFile;
    protected _hdkeyCache?: any;

    constructor(options: KeymasterOptions) {
        if (!options || !options.gatekeeper || !options.gatekeeper.createDID) {
            throw new InvalidParameterError('options.gatekeeper');
        }
        if (!options.wallet || !options.wallet.loadWallet || !options.wallet.saveWallet) {
            throw new InvalidParameterError('options.wallet');
        }
        if (!options.cipher || !options.cipher.verifySig) {
            throw new InvalidParameterError('options.cipher');
        }
        if (!options.passphrase) {
            throw new InvalidParameterError('options.passphrase');
        }

        this.passphrase = options.passphrase;
        this.gatekeeper = options.gatekeeper;
        this.db = options.wallet;
        this.cipher = options.cipher;

        this.defaultRegistry = options.defaultRegistry || 'hyperswarm';
        this.ephemeralRegistry = 'hyperswarm';
        this.maxNameLength = options.maxNameLength || 32;
        this.maxDataLength = 8 * 1024; // 8 KB max data to store in a JSON object
    }

    async listRegistries(): Promise<string[]> {
        return this.gatekeeper.listRegistries();
    }

    async mutateWallet(
        mutator: (wallet: WalletFile) => void | Promise<void>
    ): Promise<void> {
        // Create wallet if none and make sure _walletCache is set
        if (!this._walletCache) {
            await this.loadWallet();
        }

        await this.db.updateWallet(async (stored: StoredWallet) => {
            const decrypted = this._walletCache!;

            const before = JSON.stringify(decrypted);
            await mutator(decrypted);
            const after = JSON.stringify(decrypted);

            if (before === after) {
                return;
            }

            const reenc = await this.encryptWalletForStorage(decrypted);
            Object.assign(stored as WalletEncFile, reenc);

            this._walletCache = decrypted;
        });
    }

    async loadWallet(): Promise<WalletFile> {
        if (this._walletCache) {
            return this._walletCache;
        }

        let stored = await this.db.loadWallet() as WalletFile | null;

        if (!stored) {
            stored = await this.newWallet();
        }

        const upgraded: WalletFile = await this.upgradeWallet(stored);
        this._walletCache = await this.decryptWallet(upgraded);
        return this._walletCache;
    }

    async saveWallet(
        wallet: StoredWallet,
        overwrite = true
    ): Promise<boolean> {
        let upgraded: WalletFile = await this.upgradeWallet(wallet);
        // Decrypt if encrypted to verify passphrase and get decrypted form
        const decrypted = await this.decryptWallet(upgraded);
        let toStore: WalletEncFile = await this.encryptWalletForStorage(decrypted);

        const ok = await this.db.saveWallet(toStore, overwrite);
        if (ok) {
            this._walletCache = decrypted;
        }
        return ok;
    }

    async newWallet(
        mnemonic?: string,
        overwrite = false
    ): Promise<WalletFile> {
        try {
            if (!mnemonic) {
                mnemonic = this.cipher.generateMnemonic();
            }

            this._hdkeyCache = this.cipher.generateHDKey(mnemonic);
        } catch (error) {
            throw new InvalidParameterError('mnemonic');
        }

        const mnemonicEnc = await encMnemonic(mnemonic, this.passphrase);
        const wallet: WalletFile = {
            version: 1,
            seed: { mnemonicEnc },
            counter: 0,
            ids: {}
        };

        const ok = await this.saveWallet(wallet, overwrite)
        if (!ok) {
            throw new KeymasterError('save wallet failed');
        }

        return wallet;
    }

    async decryptMnemonic(): Promise<string> {
        const wallet = await this.loadWallet();
        return this.getMnemonicForDerivation(wallet);
    }

    async getMnemonicForDerivation(wallet: WalletFile): Promise<string> {
        return decMnemonic(wallet.seed.mnemonicEnc!, this.passphrase!);
    }

    async checkWallet(): Promise<CheckWalletResult> {
        const wallet = await this.loadWallet();

        let checked = 0;
        let invalid = 0;
        let deleted = 0;

        // Validate keys
        await this.resolveSeedBank();

        for (const name of Object.keys(wallet.ids)) {
            try {
                const doc = await this.resolveDID(wallet.ids[name].did);

                if (doc.didDocumentMetadata?.deactivated) {
                    deleted += 1;
                }
            }
            catch (error) {
                invalid += 1;
            }

            checked += 1;
        }

        for (const id of Object.values(wallet.ids)) {
            if (id.owned) {
                for (const did of id.owned) {
                    try {
                        const doc = await this.resolveDID(did);

                        if (doc.didDocumentMetadata?.deactivated) {
                            deleted += 1;
                        }
                    }
                    catch (error) {
                        invalid += 1;
                    }

                    checked += 1;
                }
            }

            if (id.held) {
                for (const did of id.held) {
                    try {
                        const doc = await this.resolveDID(did);

                        if (doc.didDocumentMetadata?.deactivated) {
                            deleted += 1;
                        }
                    }
                    catch (error) {
                        invalid += 1;
                    }

                    checked += 1;
                }
            }
        }

        if (wallet.names) {
            for (const name of Object.keys(wallet.names)) {
                try {
                    const doc = await this.resolveDID(wallet.names[name]);

                    if (doc.didDocumentMetadata?.deactivated) {
                        deleted += 1;
                    }
                }
                catch (error) {
                    invalid += 1;
                }

                checked += 1;
            }
        }

        return { checked, invalid, deleted };
    }

    async fixWallet(): Promise<FixWalletResult> {
        let idsRemoved = 0;
        let ownedRemoved = 0;
        let heldRemoved = 0;
        let namesRemoved = 0;

        await this.mutateWallet(async (wallet) => {

            for (const name of Object.keys(wallet.ids)) {
                let remove = false;
                try {
                    const doc = await this.resolveDID(wallet.ids[name].did);

                    if (doc.didDocumentMetadata?.deactivated) {
                        remove = true;
                    }
                } catch {
                    remove = true;
                }

                if (remove) {
                    delete wallet.ids[name];
                    idsRemoved++;
                }
            }

            for (const id of Object.values(wallet.ids)) {
                if (id.owned) {
                    for (let i = 0; i < id.owned.length; i++) {
                        let remove = false;
                        try {
                            const doc = await this.resolveDID(id.owned[i]);

                            if (doc.didDocumentMetadata?.deactivated) {
                                remove = true;
                            }
                        } catch {
                            remove = true;
                        }

                        if (remove) {
                            id.owned.splice(i, 1);
                            i--;
                            ownedRemoved++;
                        }
                    }
                }

                if (id.held) {
                    for (let i = 0; i < id.held.length; i++) {
                        let remove = false;
                        try {
                            const doc = await this.resolveDID(id.held[i]);

                            if (doc.didDocumentMetadata?.deactivated) {
                                remove = true;
                            }
                        } catch {
                            remove = true;
                        }

                        if (remove) {
                            id.held.splice(i, 1);
                            i--;
                            heldRemoved++;
                        }
                    }
                }
            }

            if (wallet.names) {
                for (const name of Object.keys(wallet.names)) {
                    let remove = false;
                    try {
                        const doc = await this.resolveDID(wallet.names[name]);

                        if (doc.didDocumentMetadata?.deactivated) {
                            remove = true;
                        }
                    } catch {
                        remove = true;
                    }

                    if (remove) {
                        delete wallet.names[name];
                        namesRemoved++;
                    }
                }
            }
        });

        return { idsRemoved, ownedRemoved, heldRemoved, namesRemoved };
    }

    async resolveSeedBank(): Promise<DidCidDocument> {
        const keypair = await this.hdKeyPair();

        const operation: Operation = {
            type: "create",
            created: new Date(0).toISOString(),
            registration: {
                version: 1,
                type: "agent",
                registry: this.defaultRegistry,
            },
            publicJwk: keypair.publicJwk,
        };

        const msgHash = this.cipher.hashJSON(operation);
        const signatureHex = this.cipher.signHash(msgHash, keypair.privateJwk);
        const signed: Operation = {
            ...operation,
            proof: {
                type: "EcdsaSecp256k1Signature2019",
                created: new Date(0).toISOString(),
                verificationMethod: "#key-1",
                proofPurpose: "authentication",
                proofValue: hexToBase64url(signatureHex),
            }
        }
        const did = await this.gatekeeper.createDID(signed);
        return this.gatekeeper.resolveDID(did);
    }

    async updateSeedBank(doc: DidCidDocument): Promise<boolean> {
        const keypair = await this.hdKeyPair();
        const did = doc.didDocument?.id;
        if (!did) {
            throw new InvalidParameterError('seed bank missing DID');
        }
        const current = await this.gatekeeper.resolveDID(did);
        const previd = current.didDocumentMetadata?.versionId;

        const operation: Operation = {
            type: "update",
            did,
            previd,
            doc,
        };

        const msgHash = this.cipher.hashJSON(operation);
        const signatureHex = this.cipher.signHash(msgHash, keypair.privateJwk);
        const signed: Operation = {
            ...operation,
            proof: {
                type: "EcdsaSecp256k1Signature2019",
                created: new Date().toISOString(),
                verificationMethod: `${did}#key-1`,
                proofPurpose: "authentication",
                proofValue: hexToBase64url(signatureHex),
            }
        };

        return await this.gatekeeper.updateDID(signed);
    }

    async backupWallet(registry = this.defaultRegistry, wallet?: WalletFile): Promise<string> {

        if (!wallet) {
            wallet = await this.loadWallet();
        }

        const keypair = await this.hdKeyPair();
        const seedBank = await this.resolveSeedBank();
        const msg = JSON.stringify(wallet);
        const backup = this.cipher.encryptMessage(keypair.publicJwk, keypair.privateJwk, msg);

        const operation: Operation = {
            type: "create",
            created: new Date().toISOString(),
            registration: {
                version: 1,
                type: "asset",
                registry: registry,
            },
            controller: seedBank.didDocument?.id,
            data: { backup: backup },
        };

        const msgHash = this.cipher.hashJSON(operation);
        const signatureHex = this.cipher.signHash(msgHash, keypair.privateJwk);

        const signed: Operation = {
            ...operation,
            proof: {
                type: "EcdsaSecp256k1Signature2019",
                created: new Date().toISOString(),
                verificationMethod: `${seedBank.didDocument?.id}#key-1`,
                proofPurpose: "authentication",
                proofValue: hexToBase64url(signatureHex),
            }
        };

        const backupDID = await this.gatekeeper.createDID(signed);

        if (seedBank.didDocumentData && typeof seedBank.didDocumentData === 'object' && !Array.isArray(seedBank.didDocumentData)) {
            const data = seedBank.didDocumentData as { wallet?: string };
            data.wallet = backupDID;
            await this.updateSeedBank(seedBank);
        }

        return backupDID;
    }

    async recoverWallet(did?: string): Promise<WalletFile> {
        try {
            if (!did) {
                const seedBank = await this.resolveSeedBank();
                if (seedBank.didDocumentData && typeof seedBank.didDocumentData === 'object' && !Array.isArray(seedBank.didDocumentData)) {
                    const data = seedBank.didDocumentData as { wallet?: string };
                    did = data.wallet;
                }
                if (!did) {
                    throw new InvalidParameterError('No backup DID found');
                }
            }

            const keypair = await this.hdKeyPair();
            const data = await this.resolveAsset(did);
            if (!data) {
                throw new InvalidParameterError('No asset data found');
            }

            const castData = data as { backup?: string };

            if (typeof castData.backup !== 'string') {
                throw new InvalidParameterError('Asset "backup" is missing or not a string');
            }

            const backup = this.cipher.decryptMessage(keypair.publicJwk, keypair.privateJwk, castData.backup);
            let wallet = JSON.parse(backup);

            if (isWalletFile(wallet)) {
                const mnemonic = await this.decryptMnemonic();
                // Backup might have a different mnemonic passphase so re-encrypt
                wallet.seed.mnemonicEnc = await encMnemonic(mnemonic, this.passphrase);
            }

            await this.mutateWallet(async (current) => {
                // Clear all existing properties from the current wallet
                // This ensures a clean slate before restoring the recovered wallet
                for (const k in current) {
                    delete current[k as keyof StoredWallet];
                }

                // Upgrade the recovered wallet to the latest version if needed
                wallet = await this.upgradeWallet(wallet);

                // Decrypt the wallet if needed
                wallet = isWalletEncFile(wallet) ? await this.decryptWalletFromStorage(wallet) : wallet;

                // Copy all properties from the recovered wallet into the cleared current wallet
                // This effectively replaces the current wallet with the recovered one
                Object.assign(current, wallet);
            });

            return this.loadWallet();
        }
        catch (error) {
            // If we can't recover the wallet, just return the current one
            return this.loadWallet();
        }
    }

    async listIds(): Promise<string[]> {
        const wallet = await this.loadWallet();
        return Object.keys(wallet.ids);
    }

    async getCurrentId(): Promise<string | undefined> {
        const wallet = await this.loadWallet();
        return wallet.current;
    }

    async setCurrentId(name: string) {
        await this.mutateWallet((wallet) => {
            if (!(name in wallet.ids)) {
                throw new UnknownIDError();
            }
            wallet.current = name;
        });
        return true;
    }

    didMatch(
        did1: string,
        did2: string
    ): boolean {
        const suffix1 = did1.split(':').pop();
        const suffix2 = did2.split(':').pop();

        return (suffix1 === suffix2);
    }

    async fetchIdInfo(id?: string, wallet?: WalletFile): Promise<IDInfo> {
        // Callers should pass in the wallet if they are going to modify and save it later
        if (!wallet) {
            wallet = await this.loadWallet();
        }

        let idInfo = null;

        if (id) {
            if (id.startsWith('did')) {
                for (const name of Object.keys(wallet.ids)) {
                    const info = wallet.ids[name];

                    if (this.didMatch(id, info.did)) {
                        idInfo = info;
                        break;
                    }
                }
            }
            else {
                idInfo = wallet.ids[id];
            }
        }
        else {
            if (!wallet.current) {
                throw new KeymasterError('No current ID');
            }

            idInfo = wallet.ids[wallet.current];
        }

        if (!idInfo) {
            throw new UnknownIDError();
        }

        return idInfo;
    }

    async hdKeyPair(): Promise<EcdsaJwkPair> {
        const wallet = await this.loadWallet();
        const hdkey = await this.getHDKeyFromCacheOrMnemonic(wallet);
        return this.cipher.generateJwk(hdkey.privateKey!);
    }

    getPublicKeyJwk(doc: DidCidDocument): EcdsaJwkPublic {
        // TBD Return the right public key, not just the first one
        if (!doc.didDocument) {
            throw new KeymasterError('Missing didDocument.');
        }
        const verificationMethods = doc.didDocument.verificationMethod;
        if (!verificationMethods || verificationMethods.length === 0) {
            throw new KeymasterError('The DID document does not contain any verification methods.');
        }
        const publicKeyJwk = verificationMethods[0].publicKeyJwk;
        if (!publicKeyJwk) {
            throw new KeymasterError('The publicKeyJwk is missing in the first verification method.');
        }
        return publicKeyJwk;
    }

    async fetchKeyPair(name?: string): Promise<EcdsaJwkPair | null> {
        const wallet = await this.loadWallet();
        const id = await this.fetchIdInfo(name);
        const hdkey = await this.getHDKeyFromCacheOrMnemonic(wallet);
        const doc = await this.resolveDID(id.did, { confirm: true });
        const confirmedPublicKeyJwk = this.getPublicKeyJwk(doc);

        for (let i = id.index; i >= 0; i--) {
            const path = `m/44'/0'/${id.account}'/0/${i}`;
            const didkey = hdkey.derive(path);
            const keypair = this.cipher.generateJwk(didkey.privateKey!);

            if (keypair.publicJwk.x === confirmedPublicKeyJwk.x &&
                keypair.publicJwk.y === confirmedPublicKeyJwk.y
            ) {
                return keypair;
            }
        }

        return null;
    }

    async createAsset(
        data: unknown,
        options: CreateAssetOptions = {}
    ): Promise<string> {
        let { registry = this.defaultRegistry, controller, validUntil, name } = options;

        if (validUntil) {
            const validate = new Date(validUntil);

            if (isNaN(validate.getTime())) {
                throw new InvalidParameterError('options.validUntil');
            }
        }

        if (name) {
            const wallet = await this.loadWallet();
            this.validateName(name, wallet);
        }

        if (!data) {
            throw new InvalidParameterError('data');
        }

        const id = await this.fetchIdInfo(controller);
        const block = await this.gatekeeper.getBlock(registry);
        const blockid = block?.hash;

        const operation: Operation = {
            type: "create",
            created: new Date().toISOString(),
            blockid,
            registration: {
                version: 1,
                type: "asset",
                registry,
                validUntil
            },
            controller: id.did,
            data,
        };

        const signed = await this.addProof(operation, controller, "authentication");
        const did = await this.gatekeeper.createDID(signed);

        // Keep assets that will be garbage-collected out of the owned list
        if (!validUntil) {
            await this.addToOwned(did);
        }

        if (name) {
            await this.addName(name, did);
        }

        return did;
    }

    async cloneAsset(
        id: string,
        options: CreateAssetOptions = {}
    ): Promise<string> {
        const assetDoc = await this.resolveDID(id);

        if (assetDoc.didDocumentRegistration?.type !== 'asset') {
            throw new InvalidParameterError('id');
        }

        const assetData = assetDoc.didDocumentData || {};
        const cloneData = { ...assetData, cloned: assetDoc.didDocument!.id };

        return this.createAsset(cloneData, options);
    }

    // Document methods (generateImageAsset, createImage, etc.) are provided by DocumentMixin

    async encryptMessage(
        msg: string,
        receiver: string,
        options: EncryptOptions = {}
    ): Promise<string> {
        const {
            encryptForSender = true,
            includeHash = false,
        } = options;

        const id = await this.fetchIdInfo();
        const senderKeypair = await this.fetchKeyPair();
        if (!senderKeypair) {
            throw new KeymasterError('No valid sender keypair');
        }

        const doc = await this.resolveDID(receiver, { confirm: true });
        const receivePublicJwk = this.getPublicKeyJwk(doc);

        const cipher_sender = encryptForSender ? this.cipher.encryptMessage(senderKeypair.publicJwk, senderKeypair.privateJwk, msg) : null;
        const cipher_receiver = this.cipher.encryptMessage(receivePublicJwk, senderKeypair.privateJwk, msg);
        const cipher_hash = includeHash ? this.cipher.hashMessage(msg) : null;

        const encrypted: EncryptedMessage = {
            sender: id.did,
            created: new Date().toISOString(),
            cipher_hash,
            cipher_sender,
            cipher_receiver,
        }

        return await this.createAsset({ encrypted }, options);
    }

    async decryptWithDerivedKeys(wallet: WalletFile, id: IDInfo, senderPublicJwk: EcdsaJwkPublic, ciphertext: string): Promise<string> {
        const hdkey = await this.getHDKeyFromCacheOrMnemonic(wallet);

        // Try all private keys for this ID, starting with the most recent and working backward
        let index = id.index;
        while (index >= 0) {
            const path = `m/44'/0'/${id.account}'/0/${index}`;
            const didkey = hdkey.derive(path);
            const receiverKeypair = this.cipher.generateJwk(didkey.privateKey!);
            try {
                return this.cipher.decryptMessage(senderPublicJwk, receiverKeypair.privateJwk, ciphertext);
            }
            catch (error) {
                index -= 1;
            }
        }

        throw new KeymasterError("ID can't decrypt ciphertext");
    }

    async decryptMessage(did: string): Promise<string> {
        const wallet = await this.loadWallet();
        const id = await this.fetchIdInfo();
        const asset = await this.resolveAsset(did);

        if (!asset) {
            throw new InvalidParameterError('did not encrypted');
        }

        const castAsset = asset as { encrypted?: EncryptedMessage, cipher_hash?: string };
        if (!castAsset.encrypted && !castAsset.cipher_hash) {
            throw new InvalidParameterError('did not encrypted');
        }

        const crypt = (castAsset.encrypted ? castAsset.encrypted : castAsset) as EncryptedMessage;

        const doc = await this.resolveDID(crypt.sender, { confirm: true, versionTime: crypt.created });
        const senderPublicJwk = this.getPublicKeyJwk(doc);

        const ciphertext = (crypt.sender === id.did && crypt.cipher_sender) ? crypt.cipher_sender : crypt.cipher_receiver;
        return await this.decryptWithDerivedKeys(wallet, id, senderPublicJwk, ciphertext!);
    }

    async encryptJSON(
        json: unknown,
        did: string,
        options: EncryptOptions = {}
    ): Promise<string> {
        const plaintext = JSON.stringify(json);
        return this.encryptMessage(plaintext, did, options);
    }

    async decryptJSON(did: string): Promise<unknown> {
        const plaintext = await this.decryptMessage(did);

        try {
            return JSON.parse(plaintext);
        }
        catch (error) {
            throw new InvalidParameterError('did not encrypted JSON');
        }
    }

    async addProof<T extends object>(
        obj: T,
        controller?: string,
        proofPurpose: ProofPurpose = "assertionMethod"
    ): Promise<T & { proof: Proof }> {
        if (obj == null) {
            throw new InvalidParameterError('obj');
        }

        // Fetches current ID if name is missing
        const id = await this.fetchIdInfo(controller);
        const keypair = await this.fetchKeyPair(controller);

        if (!keypair) {
            throw new KeymasterError('addProof: no keypair');
        }

        // Get the key fragment from the DID document
        const doc = await this.resolveDID(id.did, { confirm: true });
        const keyFragment = doc.didDocument?.verificationMethod?.[0]?.id || '#key-1';

        try {
            const msgHash = this.cipher.hashJSON(obj);
            const signatureHex = this.cipher.signHash(msgHash, keypair.privateJwk);
            const proofValue = hexToBase64url(signatureHex);

            return {
                ...obj,
                proof: {
                    type: "EcdsaSecp256k1Signature2019",
                    created: new Date().toISOString(),
                    verificationMethod: `${id.did}${keyFragment}`,
                    proofPurpose,
                    proofValue,
                }
            };
        }
        catch (error) {
            throw new InvalidParameterError('obj');
        }
    }

    async verifyProof<T extends PossiblyProofed>(obj: T): Promise<boolean> {
        if (!obj?.proof) {
            return false;
        }

        const { proof } = obj;

        if (proof.type !== "EcdsaSecp256k1Signature2019") {
            return false;
        }

        if (!proof.verificationMethod) {
            return false;
        }

        // Extract DID from verificationMethod
        const [signerDid] = proof.verificationMethod.split('#');

        const jsonCopy = JSON.parse(JSON.stringify(obj));
        delete jsonCopy.proof;
        const msgHash = this.cipher.hashJSON(jsonCopy);

        const doc = await this.resolveDID(signerDid, { versionTime: proof.created });
        const publicJwk = this.getPublicKeyJwk(doc);

        try {
            const signatureHex = base64urlToHex(proof.proofValue);
            return this.cipher.verifySig(msgHash, signatureHex, publicJwk);
        }
        catch (error) {
            return false;
        }
    }

    async updateDID(id: string, doc: DidCidDocument): Promise<boolean> {
        const did = await this.lookupDID(id);
        const current = await this.resolveDID(did);
        const previd = current.didDocumentMetadata?.versionId;

        // Strip metadata fields from the update doc
        delete doc.didDocumentMetadata;
        delete doc.didResolutionMetadata;

        const block = await this.gatekeeper.getBlock(current.didDocumentRegistration!.registry);
        const blockid = block?.hash;

        const operation: Operation = {
            type: "update",
            did,
            previd,
            blockid,
            doc,
        };

        let controller;

        if (current.didDocumentRegistration?.type === 'agent') {
            controller = current.didDocument?.id;
        }
        else if (current.didDocumentRegistration?.type === 'asset') {
            controller = current.didDocument?.controller;
        }

        const signed = await this.addProof(operation, controller, "authentication");
        return this.gatekeeper.updateDID(signed);
    }

    async revokeDID(id: string): Promise<boolean> {
        const did = await this.lookupDID(id);
        const current = await this.resolveDID(did);
        const previd = current.didDocumentMetadata?.versionId;
        const block = await this.gatekeeper.getBlock(current.didDocumentRegistration!.registry);
        const blockid = block?.hash;

        const operation: Operation = {
            type: "delete",
            did,
            previd,
            blockid
        };

        let controller;

        if (current.didDocumentRegistration?.type === 'agent') {
            controller = current.didDocument?.id;
        }
        else if (current.didDocumentRegistration?.type === 'asset') {
            controller = current.didDocument?.controller;
        }

        const signed = await this.addProof(operation, controller, "authentication");

        const ok = await this.gatekeeper.deleteDID(signed);

        if (ok && current.didDocument?.controller) {
            await this.removeFromOwned(did, current.didDocument.controller);
        }

        return ok;
    }

    async addToOwned(
        did: string,
        owner?: string
    ): Promise<boolean> {
        await this.mutateWallet(async (wallet) => {
            const id = await this.fetchIdInfo(owner, wallet);
            const owned = new Set(id.owned);
            owned.add(did);
            id.owned = Array.from(owned);
        });
        return true;
    }

    async removeFromOwned(
        did: string,
        owner: string
    ): Promise<boolean> {
        let ownerFound = false;
        await this.mutateWallet(async (wallet) => {
            const id = await this.fetchIdInfo(owner, wallet);
            if (!id.owned) {
                return;
            }
            ownerFound = true;
            id.owned = id.owned.filter(item => item !== did);
        });
        return ownerFound;
    }

    async addToHeld(did: string): Promise<boolean> {
        await this.mutateWallet((wallet) => {
            const id = wallet.ids[wallet.current!];
            const held = new Set(id.held);
            held.add(did);
            id.held = Array.from(held);
        });
        return true;
    }

    async removeFromHeld(did: string): Promise<boolean> {
        let changed = false;
        await this.mutateWallet((wallet) => {
            const id = wallet.ids[wallet.current!];
            const held = new Set(id.held);
            if (held.delete(did)) {
                id.held = Array.from(held);
                changed = true;
            }
        });
        return changed;
    }

    async lookupDID(name: string): Promise<string> {
        try {
            if (name.startsWith('did:')) {
                return name;
            }
        }
        catch {
            throw new InvalidDIDError();
        }

        const wallet = await this.loadWallet();

        if (wallet.names && name in wallet.names) {
            return wallet.names[name];
        }

        if (wallet.ids && name in wallet.ids) {
            return wallet.ids[name].did;
        }

        throw new UnknownIDError();
    }

    async resolveDID(
        did: string,
        options?: ResolveDIDOptions
    ): Promise<DidCidDocument> {
        const actualDid = await this.lookupDID(did);
        const docs = await this.gatekeeper.resolveDID(actualDid, options);

        if (docs.didResolutionMetadata?.error) {
            if (docs.didResolutionMetadata.error === 'notFound') {
                throw new InvalidDIDError('unknown');
            }

            if (docs.didResolutionMetadata.error === 'invalidDid') {
                throw new InvalidDIDError('bad format');
            }
        }

        const controller = docs.didDocument?.controller || docs.didDocument?.id;
        const isOwned = await this.idInWallet(controller);

        // Convert versionSequence string to numeric version
        const versionSequence = docs.didDocumentMetadata?.versionSequence;
        const version = versionSequence ? parseInt(versionSequence, 10) : undefined;

        // Augment the DID document metadata with the DID ownership status and numeric version
        docs.didDocumentMetadata = {
            ...docs.didDocumentMetadata,
            version,
            isOwned,
        } as DocumentMetadata & { isOwned?: boolean };

        return docs;
    }

    async idInWallet(did?: string): Promise<boolean> {
        try {
            await this.fetchIdInfo(did);
            return true;
        }
        catch (error) {
            return false;
        }
    }

    async resolveAsset(did: string, options?: ResolveDIDOptions): Promise<any> {
        const doc = await this.resolveDID(did, options);

        if (!doc?.didDocument?.controller || !doc?.didDocumentData || doc.didDocumentMetadata?.deactivated) {
            return {};
        }

        return doc.didDocumentData;
    }

    async updateAsset(
        did: string,
        data: Record<string, unknown>
    ): Promise<boolean> {
        const doc = await this.resolveDID(did);
        const currentData = doc.didDocumentData || {};

        const updatedData = {
            ...currentData,
            ...data
        };

        return this.updateDID(did, { didDocumentData: updatedData });
    }

    async transferAsset(
        id: string,
        controller: string
    ): Promise<boolean> {
        const assetDoc = await this.resolveDID(id);

        if (assetDoc.didDocumentRegistration?.type !== 'asset') {
            throw new InvalidParameterError('id');
        }

        if (assetDoc.didDocument!.controller === controller) {
            return true;
        }

        const agentDoc = await this.resolveDID(controller);

        if (agentDoc.didDocumentRegistration?.type !== 'agent') {
            throw new InvalidParameterError('controller');
        }

        const assetDID = assetDoc.didDocument!.id;
        const prevOwner = assetDoc.didDocument!.controller;

        const updatedDidDocument = {
            ...assetDoc.didDocument!,
            controller: agentDoc.didDocument!.id,
        };

        const ok = await this.updateDID(id, { didDocument: updatedDidDocument });

        if (ok && assetDID && prevOwner) {
            await this.removeFromOwned(assetDID, prevOwner);

            try {
                await this.addToOwned(assetDID, controller);
            }
            catch (error) {
                // New controller is not in our wallet
            }
        }

        return ok;
    }

    async listAssets(owner?: string) {
        const id = await this.fetchIdInfo(owner);
        return id.owned || [];
    }

    validateName(
        name: string,
        wallet?: WalletFile
    ) {
        if (typeof name !== 'string' || !name.trim()) {
            throw new InvalidParameterError('name must be a non-empty string');
        }

        name = name.trim(); // Remove leading/trailing whitespace

        if (name.length > this.maxNameLength) {
            throw new InvalidParameterError(`name too long`);
        }

        if (/[^\P{Cc}]/u.test(name)) {
            throw new InvalidParameterError('name contains unprintable characters');
        }

        const alreadyUsedError = 'name already used';

        if (wallet && wallet.names && name in wallet.names) {
            throw new InvalidParameterError(alreadyUsedError);
        }

        if (wallet && wallet.ids && name in wallet.ids) {
            throw new InvalidParameterError(alreadyUsedError);
        }

        return name;
    }

    async createId(
        name: string,
        options: { registry?: string } = {}
    ): Promise<string> {
        let did = '';
        await this.mutateWallet(async (wallet) => {
            const account = wallet.counter;
            const index = 0;
            const signed = await this.createIdOperation(name, account, options);

            did = await this.gatekeeper.createDID(signed);

            wallet.ids[name] = { did, account, index };
            wallet.counter += 1;
            wallet.current = name;
        });

        return did;
    }

    async createIdOperation(
        name: string,
        account: number = 0,
        options: { registry?: string } = {}
    ): Promise<Operation> {
        const { registry = this.defaultRegistry } = options;
        const wallet = await this.loadWallet();

        name = this.validateName(name, wallet);

        const hdkey = await this.getHDKeyFromCacheOrMnemonic(wallet);
        const path = `m/44'/0'/${account}'/0/0`;
        const didkey = hdkey.derive(path);
        const keypair = this.cipher.generateJwk(didkey.privateKey!);

        const block = await this.gatekeeper.getBlock(registry);
        const blockid = block?.hash;

        const operation: Operation = {
            type: 'create',
            created: new Date().toISOString(),
            blockid,
            registration: {
                version: 1,
                type: 'agent',
                registry
            },
            publicJwk: keypair.publicJwk,
        };

        const msgHash = this.cipher.hashJSON(operation);
        const signatureHex = this.cipher.signHash(msgHash, keypair.privateJwk);
        const signed: Operation = {
            ...operation,
            proof: {
                type: "EcdsaSecp256k1Signature2019",
                created: new Date().toISOString(),
                verificationMethod: "#key-1",
                proofPurpose: "authentication",
                proofValue: hexToBase64url(signatureHex),
            },
        };
        return signed;
    }

    async removeId(name: string): Promise<boolean> {
        await this.mutateWallet((wallet) => {
            if (!(name in wallet.ids)) {
                throw new UnknownIDError();
            }
            delete wallet.ids[name];
            if (wallet.current === name) {
                wallet.current = Object.keys(wallet.ids)[0] || '';
            }
        });
        return true;
    }

    async renameId(
        id: string,
        name: string
    ): Promise<boolean> {
        await this.mutateWallet((wallet) => {
            name = this.validateName(name);

            if (!(id in wallet.ids)) {
                throw new UnknownIDError();
            }
            if (name in wallet.ids) {
                throw new InvalidParameterError('name already used');
            }

            wallet.ids[name] = wallet.ids[id];
            delete wallet.ids[id];

            if (wallet.current && wallet.current === id) {
                wallet.current = name;
            }
        });
        return true;
    }

    async backupId(id?: string): Promise<boolean> {
        // Backs up current ID if id is not provided
        const wallet = await this.loadWallet();
        const name = id || wallet.current;
        if (!name) {
            throw new InvalidParameterError('no current ID');
        }
        const idInfo = await this.fetchIdInfo(name, wallet);
        const keypair = await this.hdKeyPair();
        const data = {
            name: name,
            id: idInfo,
        };
        const msg = JSON.stringify(data);
        const backup = this.cipher.encryptMessage(keypair.publicJwk, keypair.privateJwk, msg);
        const doc = await this.resolveDID(idInfo.did);
        const registry = doc.didDocumentRegistration?.registry;
        if (!registry) {
            throw new InvalidParameterError('no registry found for agent DID');
        }

        const backupStoreDid = await this.createAsset({ backup: backup }, { registry, controller: name });

        if (doc.didDocumentData) {
            const currentData = doc.didDocumentData as { backupStore?: string };
            const updatedData = { ...currentData, backupStore: backupStoreDid };
            return this.updateDID(name, { didDocumentData: updatedData });
        }
        return false;
    }

    async recoverId(did: string): Promise<string> {
        try {
            const keypair = await this.hdKeyPair();

            const doc = await this.resolveDID(did);
            const docData = doc.didDocumentData as { backupStore?: string };
            if (!docData.backupStore) {
                throw new InvalidDIDError('didDocumentData missing backupStore');
            }

            const backupStore = await this.resolveAsset(docData.backupStore) as { backup?: string };
            if (typeof backupStore.backup !== 'string') {
                throw new InvalidDIDError('backup not found in backupStore');
            }

            const backup = this.cipher.decryptMessage(keypair.publicJwk, keypair.privateJwk, backupStore.backup);
            const data = JSON.parse(backup) as { name: string; id: IDInfo };

            await this.mutateWallet((wallet) => {
                if (wallet.ids[data.name]) {
                    throw new KeymasterError(`${data.name} already exists in wallet`);
                }
                wallet.ids[data.name] = data.id;
                wallet.current = data.name;
                wallet.counter += 1;
            });

            return data.name;
        } catch (error: any) {
            if (error.type === 'Keymaster') {
                throw error;
            } else {
                throw new InvalidDIDError();
            }
        }
    }

    async rotateKeys(): Promise<boolean> {
        let ok = false;

        await this.mutateWallet(async (wallet) => {
            const id = wallet.ids[wallet.current!];
            const nextIndex = id.index + 1;

            const hdkey = await this.getHDKeyFromCacheOrMnemonic(wallet);
            const path = `m/44'/0'/${id.account}'/0/${nextIndex}`;
            const didkey = hdkey.derive(path);
            const keypair = this.cipher.generateJwk(didkey.privateKey!);

            const doc = await this.resolveDID(id.did);

            if (!doc.didDocumentMetadata?.confirmed) {
                throw new KeymasterError('Cannot rotate keys');
            }
            if (!doc.didDocument?.verificationMethod) {
                throw new KeymasterError('DID Document missing verificationMethod');
            }

            const vmethod = { ...doc.didDocument.verificationMethod[0] };
            vmethod.id = `#key-${nextIndex + 1}`;
            vmethod.publicKeyJwk = keypair.publicJwk;

            const updatedDidDocument = {
                ...doc.didDocument,
                verificationMethod: [vmethod],
                authentication: [vmethod.id],
                assertionMethod: [vmethod.id],
            };

            ok = await this.updateDID(id.did, { didDocument: updatedDidDocument });
            if (!ok) {
                throw new KeymasterError('Cannot rotate keys');
            }

            id.index = nextIndex; // persist in same mutation
        });

        return ok;
    }

    async listNames(
        options: {
            includeIDs?: boolean
        } = {}
    ): Promise<Record<string, string>> {
        const { includeIDs = false } = options;
        const wallet = await this.loadWallet();
        const names = wallet.names || {};

        if (includeIDs) {
            for (const [name, id] of Object.entries(wallet.ids || {})) {
                names[name] = id.did;
            }
        }

        return names;
    }

    async addName(
        name: string,
        did: string
    ): Promise<boolean> {
        await this.mutateWallet((wallet) => {
            if (!wallet.names) {
                wallet.names = {};
            }
            name = this.validateName(name, wallet);
            wallet.names[name] = did;
        });
        return true;
    }

    async getName(name: string): Promise<string | null> {
        const wallet = await this.loadWallet();

        if (wallet.names && name in wallet.names) {
            return wallet.names[name];
        }

        return null;
    }

    async removeName(name: string): Promise<boolean> {
        await this.mutateWallet((wallet) => {
            if (!wallet.names || !(name in wallet.names)) {
                return;
            }
            delete wallet.names[name];
        });
        return true;
    }

    async testAgent(id: string): Promise<boolean> {
        const doc = await this.resolveDID(id);
        return doc.didDocumentRegistration?.type === 'agent';
    }

    verifyTagList(tags: string[]): string[] {
        if (!Array.isArray(tags)) {
            throw new InvalidParameterError('tags');
        }

        const tagSet = new Set<string>();

        for (const tag of tags) {
            try {
                tagSet.add(this.validateName(tag));
            }
            catch (error) {
                throw new InvalidParameterError(`Invalid tag: '${tag}'`);
            }
        }

        return tagSet.size > 0 ? Array.from(tagSet) : [];
    }

    async verifyRecipientList(list: string[]): Promise<string[]> {
        if (!Array.isArray(list)) {
            throw new InvalidParameterError('list');
        }

        const nameList = await this.listNames({ includeIDs: true });
        let newList = [];

        for (const id of list) {
            if (typeof id !== 'string') {
                throw new InvalidParameterError(`Invalid recipient type: ${typeof id}`);
            }

            if (id in nameList) {
                const did = nameList[id];
                const isAgent = await this.testAgent(did);

                if (isAgent) {
                    newList.push(did);
                    continue;
                }

                throw new InvalidParameterError(`Invalid recipient: ${id}`);
            }

            if (isValidDID(id)) {
                newList.push(id);
                continue;
            }

            throw new InvalidParameterError(`Invalid recipient: ${id}`);
        }

        return newList;
    }

    // Basic notice creation methods (complex notice handling in NoticeMixin)
    async verifyDIDList(didList: string[]): Promise<string[]> {
        if (!Array.isArray(didList)) {
            throw new InvalidParameterError('didList');
        }

        for (const did of didList) {
            if (!isValidDID(did)) {
                throw new InvalidParameterError(`Invalid DID: ${did}`);
            }
        }

        return didList;
    }

    async verifyNotice(notice: NoticeMessage): Promise<NoticeMessage> {
        const to = await this.verifyRecipientList(notice.to);
        const dids = await this.verifyDIDList(notice.dids);

        if (to.length === 0) {
            throw new InvalidParameterError('notice.to');
        }

        if (dids.length === 0) {
            throw new InvalidParameterError('notice.dids');
        }

        return { to, dids };
    }

    async createNotice(
        message: NoticeMessage,
        options: CreateAssetOptions = {}
    ): Promise<string> {
        const notice = await this.verifyNotice(message);
        return this.createAsset({ notice }, options);
    }

    async updateNotice(
        id: string,
        message: NoticeMessage,
    ): Promise<boolean> {
        const notice = await this.verifyNotice(message);
        return this.updateAsset(id, { notice });
    }

    async addToNotices(
        did: string,
        tags: string[]
    ): Promise<boolean> {
        const verifiedTags = this.verifyTagList(tags);
        await this.mutateWallet(async (wallet) => {
            const id = await this.fetchIdInfo(undefined, wallet);
            if (!id.notices) id.notices = {};
            id.notices[did] = { tags: verifiedTags };
        });
        return true;
    }

    // Complex notice handling methods are provided by NoticeMixin

    async exportEncryptedWallet(): Promise<WalletEncFile> {
        const wallet = await this.loadWallet();
        return this.encryptWalletForStorage(wallet);
    }

    private async getHDKeyFromCacheOrMnemonic(wallet: WalletFile) {
        if (this._hdkeyCache) {
            return this._hdkeyCache;
        }

        const mnemonic = await this.getMnemonicForDerivation(wallet);
        this._hdkeyCache = this.cipher.generateHDKey(mnemonic);
        return this._hdkeyCache;
    }

    private async encryptWalletForStorage(decrypted: WalletFile): Promise<WalletEncFile> {
        const { version, seed, ...rest } = decrypted;

        const safeSeed: Seed = { mnemonicEnc: seed.mnemonicEnc };

        const hdkey = await this.getHDKeyFromCacheOrMnemonic(decrypted);
        const { publicJwk, privateJwk } = this.cipher.generateJwk(hdkey.privateKey!);

        const plaintext = JSON.stringify(rest);
        const enc = this.cipher.encryptMessage(publicJwk, privateJwk, plaintext);

        return { version: version!, seed: safeSeed, enc };
    }

    private async decryptWalletFromStorage(stored: WalletEncFile): Promise<WalletFile> {
        let mnemonic: string;
        try {
            mnemonic = await decMnemonic(stored.seed.mnemonicEnc!, this.passphrase);
        } catch {
            throw new KeymasterError('Incorrect passphrase.');
        }

        this._hdkeyCache = this.cipher.generateHDKey(mnemonic);
        const { publicJwk, privateJwk } = this.cipher.generateJwk(this._hdkeyCache.privateKey!);

        const plaintext = this.cipher.decryptMessage(publicJwk, privateJwk, stored.enc);
        const data = JSON.parse(plaintext);

        const wallet: WalletFile = { version: stored.version, seed: stored.seed, ...data };
        return wallet;
    }

    private async decryptWallet(wallet: WalletFile): Promise<WalletFile> {
        if (isWalletEncFile(wallet)) {
            wallet = await this.decryptWalletFromStorage(wallet);
        }

        if (!isWalletFile(wallet)) {
            throw new KeymasterError("Unsupported wallet version.");
        }

        return wallet;
    }

    private async upgradeWallet(wallet: any): Promise<WalletFile> {
        if (wallet.version !== 1) {
            throw new KeymasterError("Unsupported wallet version.");
        }

        return wallet;
    }
}

// Apply mixins to create the final Keymaster class
// Order matters due to dependencies between mixins
const KeymasterWithDocument = DocumentMixin(KeymasterBase);
const KeymasterWithSchema = SchemaMixin(KeymasterWithDocument);
const KeymasterWithGroup = GroupMixin(KeymasterWithSchema);
const KeymasterWithVault = VaultMixin(KeymasterWithGroup);
const KeymasterWithDmail = DmailMixin(KeymasterWithVault);
const KeymasterWithPoll = PollMixin(KeymasterWithDmail);
const KeymasterWithCredential = CredentialMixin(KeymasterWithPoll);
const KeymasterWithNotice = NoticeMixin(KeymasterWithCredential);

// Export the composed class as Keymaster
export default class Keymaster extends KeymasterWithNotice implements KeymasterInterface {
}

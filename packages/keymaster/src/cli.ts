#!/usr/bin/env node
import { program } from 'commander';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

import Keymaster from './keymaster.js';
import GatekeeperClient from '@didcid/gatekeeper/client';
import CipherNode from '@didcid/cipher/node';
import WalletJson from './db/json.js';
import WalletSQLite from './db/sqlite.js';

dotenv.config();

let keymaster: Keymaster;

const UPDATE_OK = "OK";
const UPDATE_FAILED = "Update failed";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf-8'));

program
    .version(pkg.version)
    .description('Keymaster CLI - Archon wallet management tool')
    .configureHelp({ sortSubcommands: true });

// Wallet commands
program
    .command('create-wallet')
    .description('Create a new wallet (or show existing wallet)')
    .action(async () => {
        try {
            const wallet = await keymaster.loadWallet();
            console.log(JSON.stringify(wallet, null, 4));
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('new-wallet')
    .description('Create a new wallet')
    .action(async () => {
        try {
            await keymaster.newWallet("", true);
            const wallet = await keymaster.loadWallet();
            console.log(JSON.stringify(wallet, null, 4));
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('check-wallet')
    .description('Validate DIDs in wallet')
    .action(async () => {
        try {
            const { checked, invalid, deleted } = await keymaster.checkWallet();

            if (invalid === 0 && deleted === 0) {
                console.log(`${checked} DIDs checked, no problems found`);
            }
            else {
                console.log(`${checked} DIDs checked, ${invalid} invalid DIDs found, ${deleted} deleted DIDs found`);
            }
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('fix-wallet')
    .description('Remove invalid DIDs from the wallet')
    .action(async () => {
        try {
            const { idsRemoved, ownedRemoved, heldRemoved, aliasesRemoved } = await keymaster.fixWallet();

            console.log(`${idsRemoved} IDs and ${ownedRemoved} owned DIDs and ${heldRemoved} held DIDs and ${aliasesRemoved} aliases were removed`);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('import-wallet <recovery-phrase>')
    .description('Create new wallet from a recovery phrase')
    .action(async (recoveryPhrase) => {
        try {
            const wallet = await keymaster.newWallet(recoveryPhrase);
            console.log(JSON.stringify(wallet, null, 4));
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('show-wallet')
    .description('Show wallet')
    .action(async () => {
        try {
            const wallet = await keymaster.loadWallet();
            console.log(JSON.stringify(wallet, null, 4));
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('backup-wallet-file <file>')
    .description('Backup wallet to file')
    .action(async (file) => {
        try {
            const wallet = await keymaster.exportEncryptedWallet();
            fs.writeFileSync(file, JSON.stringify(wallet, null, 4));
            console.log(UPDATE_OK);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('restore-wallet-file <file>')
    .description('Restore wallet from backup file')
    .action(async (file) => {
        try {
            const contents = fs.readFileSync(file).toString();
            const wallet = JSON.parse(contents);
            const ok = await keymaster.saveWallet(wallet, true);
            console.log(ok ? UPDATE_OK : UPDATE_FAILED);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('show-mnemonic')
    .description('Show recovery phrase for wallet')
    .action(async () => {
        try {
            const mnemonic = await keymaster.decryptMnemonic();
            console.log(mnemonic);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('backup-wallet-did')
    .description('Backup wallet to encrypted DID and seed bank')
    .action(async () => {
        try {
            const did = await keymaster.backupWallet();
            console.log(did);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('recover-wallet-did [did]')
    .description('Recover wallet from seed bank or encrypted DID')
    .action(async (did) => {
        try {
            const wallet = await keymaster.recoverWallet(did);
            console.log(JSON.stringify(wallet, null, 4));
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

// Identity commands
program
    .command('create-id <name>')
    .description('Create a new decentralized ID')
    .option('-r, --registry <registry>', 'registry to use')
    .action(async (name, options) => {
        try {
            const { registry } = options;
            const did = await keymaster.createId(name, { registry });
            console.log(did);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('resolve-id')
    .description('Resolves the current ID')
    .action(async () => {
        try {
            const current = await keymaster.getCurrentId();
            if (!current) {
                console.error('No current ID set');
                return;
            }
            const doc = await keymaster.resolveDID(current);
            console.log(JSON.stringify(doc, null, 4));
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('backup-id')
    .description('Backup the current ID to its registry')
    .action(async () => {
        try {
            const ok = await keymaster.backupId();
            console.log(ok ? UPDATE_OK : UPDATE_FAILED);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('recover-id <did>')
    .description('Recovers the ID from the DID')
    .action(async (did) => {
        try {
            const response = await keymaster.recoverId(did);
            console.log(response);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('remove-id <name>')
    .description('Deletes named ID')
    .action(async (name) => {
        try {
            await keymaster.removeId(name);
            console.log(`ID ${name} removed`);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('rename-id <oldName> <newName>')
    .description('Renames the ID')
    .action(async (oldName, newName) => {
        try {
            const ok = await keymaster.renameId(oldName, newName);
            console.log(ok ? UPDATE_OK : UPDATE_FAILED);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('list-ids')
    .description('List IDs and show current ID')
    .action(async () => {
        try {
            const current = await keymaster.getCurrentId();
            const ids = await keymaster.listIds();

            for (const id of ids) {
                if (id === current) {
                    console.log(id, ' <<< current');
                }
                else {
                    console.log(id);
                }
            }
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('use-id <name>')
    .description('Set the current ID')
    .action(async (name) => {
        try {
            await keymaster.setCurrentId(name);
            console.log(UPDATE_OK);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('rotate-keys')
    .description('Generates new set of keys for current ID')
    .action(async () => {
        try {
            const ok = await keymaster.rotateKeys();
            console.log(ok ? UPDATE_OK : UPDATE_FAILED);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

// DID commands
program
    .command('resolve-did <did> [confirm]')
    .description('Return document associated with DID')
    .action(async (did, confirm) => {
        try {
            const doc = await keymaster.resolveDID(did, { confirm: !!confirm });
            console.log(JSON.stringify(doc, null, 4));
        }
        catch (error: any) {
            console.error(`cannot resolve ${did}`);
        }
    });

program
    .command('resolve-did-version <did> <version>')
    .description('Return specified version of document associated with DID')
    .action(async (did, version) => {
        try {
            const doc = await keymaster.resolveDID(did, { versionSequence: parseInt(version, 10) });
            console.log(JSON.stringify(doc, null, 4));
        }
        catch (error: any) {
            console.error(`cannot resolve ${did}`);
        }
    });

program
    .command('revoke-did <did>')
    .description('Permanently revoke a DID')
    .action(async (did) => {
        try {
            const ok = await keymaster.revokeDID(did);
            console.log(ok ? UPDATE_OK : UPDATE_FAILED);
        }
        catch (error: any) {
            console.error(`cannot revoke ${did}`);
        }
    });

// Encryption commands
program
    .command('encrypt-message <message> <did>')
    .description('Encrypt a message for a DID')
    .action(async (msg, did) => {
        try {
            const cipherDid = await keymaster.encryptMessage(msg, did);
            console.log(cipherDid);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('encrypt-file <file> <did>')
    .description('Encrypt a file for a DID')
    .action(async (file, did) => {
        try {
            const contents = fs.readFileSync(file).toString();
            const cipherDid = await keymaster.encryptMessage(contents, did);
            console.log(cipherDid);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('decrypt-did <did>')
    .description('Decrypt an encrypted message DID')
    .action(async (did) => {
        try {
            const plaintext = await keymaster.decryptMessage(did);
            console.log(plaintext);
        }
        catch (error: any) {
            console.error(`cannot decrypt ${did}`);
        }
    });

program
    .command('decrypt-json <did>')
    .description('Decrypt an encrypted JSON DID')
    .action(async (did) => {
        try {
            const json = await keymaster.decryptJSON(did);
            console.log(JSON.stringify(json, null, 4));
        }
        catch (error: any) {
            console.error(`cannot decrypt ${did}`);
        }
    });

// Signing commands
program
    .command('sign-file <file>')
    .description('Sign a JSON file')
    .action(async (file) => {
        try {
            const contents = fs.readFileSync(file).toString();
            const json = await keymaster.addProof(JSON.parse(contents));
            console.log(JSON.stringify(json, null, 4));
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('verify-file <file>')
    .description('Verify the proof in a JSON file')
    .action(async (file) => {
        try {
            const json = JSON.parse(fs.readFileSync(file).toString());
            const isValid = await keymaster.verifyProof(json);
            console.log(`proof in ${file}`, isValid ? 'is valid' : 'is NOT valid');
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

// Challenge commands
program
    .command('create-challenge [file]')
    .description('Create a challenge (optionally from a file)')
    .option('-a, --alias <alias>', 'DID alias')
    .action(async (file, options) => {
        try {
            const { alias } = options;
            const challenge = file ? JSON.parse(fs.readFileSync(file).toString()) : undefined;
            const did = await keymaster.createChallenge(challenge, { alias });
            console.log(did);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('create-challenge-cc <did>')
    .description('Create a challenge from a credential DID')
    .option('-a, --alias <alias>', 'DID alias')
    .action(async (credentialDID, options) => {
        try {
            const { alias } = options;
            const challenge = { credentials: [{ schema: credentialDID }] };
            const did = await keymaster.createChallenge(challenge, { alias });
            console.log(did);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('create-response <challenge>')
    .description('Create a response to a challenge')
    .action(async (challenge) => {
        try {
            const did = await keymaster.createResponse(challenge);
            console.log(did);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('verify-response <response>')
    .description('Decrypt and validate a response to a challenge')
    .action(async (response) => {
        try {
            const vp = await keymaster.verifyResponse(response);
            console.log(JSON.stringify(vp, null, 4));
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

// Credential commands
program
    .command('bind-credential <schema> <subject>')
    .description('Create bound credential for a user')
    .action(async (schema, subject) => {
        try {
            const vc = await keymaster.bindCredential(subject, { schema });
            console.log(JSON.stringify(vc, null, 4));
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('issue-credential <file>')
    .description('Sign and encrypt a bound credential file')
    .option('-a, --alias <alias>', 'DID alias')
    .option('-r, --registry <registry>', 'registry to use')
    .action(async (file, options) => {
        try {
            const { alias, registry } = options;
            const vc = JSON.parse(fs.readFileSync(file).toString());
            const did = await keymaster.issueCredential(vc, { registry, alias });
            console.log(did);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('list-issued')
    .description('List issued credentials')
    .action(async () => {
        try {
            const response = await keymaster.listIssued();
            console.log(JSON.stringify(response, null, 4));
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('update-credential <did> <file>')
    .description('Update an issued credential')
    .action(async (did, file) => {
        try {
            const vc = JSON.parse(fs.readFileSync(file).toString());
            const ok = await keymaster.updateCredential(did, vc);
            console.log(ok ? UPDATE_OK : UPDATE_FAILED);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('revoke-credential <did>')
    .description('Revokes a verifiable credential')
    .action(async (did) => {
        try {
            const ok = await keymaster.revokeCredential(did);
            console.log(ok ? UPDATE_OK : UPDATE_FAILED);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('accept-credential <did>')
    .description('Save verifiable credential for current ID')
    .option('-a, --alias <alias>', 'DID alias')
    .action(async (did, options) => {
        const { alias } = options;
        try {
            const ok = await keymaster.acceptCredential(did);

            if (ok) {
                console.log(UPDATE_OK);

                if (alias) {
                    await keymaster.addAlias(alias, did);
                }
            }
            else {
                console.log(UPDATE_FAILED);
            }
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('list-credentials')
    .description('List credentials by current ID')
    .action(async () => {
        try {
            const held = await keymaster.listCredentials();
            console.log(JSON.stringify(held, null, 4));
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('get-credential <did>')
    .description('Get credential by DID')
    .action(async (did) => {
        try {
            const credential = await keymaster.getCredential(did);
            console.log(JSON.stringify(credential, null, 4));
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('publish-credential <did>')
    .description('Publish the existence of a credential to the current user manifest')
    .action(async (did) => {
        try {
            const response = await keymaster.publishCredential(did, { reveal: false });
            console.log(JSON.stringify(response, null, 4));
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('reveal-credential <did>')
    .description('Reveal a credential to the current user manifest')
    .action(async (did) => {
        try {
            const response = await keymaster.publishCredential(did, { reveal: true });
            console.log(JSON.stringify(response, null, 4));
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('unpublish-credential <did>')
    .description('Remove a credential from the current user manifest')
    .action(async (did) => {
        try {
            const response = await keymaster.unpublishCredential(did);
            console.log(response);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

// Alias commands
program
    .command('add-alias <alias> <did>')
    .description('Add an alias for a DID')
    .action(async (alias, did) => {
        try {
            await keymaster.addAlias(alias, did);
            console.log(UPDATE_OK);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('get-alias <alias>')
    .description('Get DID assigned to alias')
    .action(async (alias) => {
        try {
            const did = await keymaster.getAlias(alias);
            console.log(did || `${alias} not found`);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('remove-alias <alias>')
    .description('Removes an alias for a DID')
    .action(async (alias) => {
        try {
            await keymaster.removeAlias(alias);
            console.log(UPDATE_OK);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('list-aliases')
    .description('List DID aliases')
    .action(async () => {
        try {
            const aliases = await keymaster.listAliases();

            if (aliases) {
                console.log(JSON.stringify(aliases, null, 4));
            }
            else {
                console.log("No aliases defined");
            }
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

// Group commands
program
    .command('create-group <groupName>')
    .description('Create a new group')
    .option('-a, --alias <alias>', 'DID alias')
    .option('-r, --registry <registry>', 'registry to use')
    .action(async (groupName, options) => {
        try {
            const { alias, registry } = options;
            const did = await keymaster.createGroup(groupName, { alias, registry });
            console.log(did);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('list-groups')
    .description('List groups owned by current ID')
    .action(async () => {
        try {
            const groups = await keymaster.listGroups();
            console.log(JSON.stringify(groups, null, 4));
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('get-group <did>')
    .description('Get group by DID')
    .action(async (did) => {
        try {
            const group = await keymaster.getGroup(did);
            console.log(JSON.stringify(group, null, 4));
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('add-group-member <group> <member>')
    .description('Add a member to a group')
    .action(async (group, member) => {
        try {
            const response = await keymaster.addGroupMember(group, member);
            console.log(response);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('remove-group-member <group> <member>')
    .description('Remove a member from a group')
    .action(async (group, member) => {
        try {
            const response = await keymaster.removeGroupMember(group, member);
            console.log(response);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('test-group <group> [member]')
    .description('Determine if a member is in a group')
    .action(async (group, member) => {
        try {
            const response = await keymaster.testGroup(group, member);
            console.log(response);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

// Schema commands
program
    .command('create-schema <file>')
    .description('Create a schema from a file')
    .option('-a, --alias <alias>', 'DID alias')
    .option('-r, --registry <registry>', 'registry to use')
    .action(async (file, options) => {
        try {
            const { alias, registry } = options;
            const schema = JSON.parse(fs.readFileSync(file).toString());
            const did = await keymaster.createSchema(schema, { alias, registry });
            console.log(did);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('list-schemas')
    .description('List schemas owned by current ID')
    .action(async () => {
        try {
            const schemas = await keymaster.listSchemas();
            console.log(JSON.stringify(schemas, null, 4));
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('get-schema <did>')
    .description('Get schema by DID')
    .action(async (did) => {
        try {
            const schema = await keymaster.getSchema(did);
            console.log(JSON.stringify(schema, null, 4));
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('create-schema-template <schema>')
    .description('Create a template from a schema')
    .action(async (schema) => {
        try {
            const template = await keymaster.createTemplate(schema);
            console.log(JSON.stringify(template, null, 4));
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

// Asset commands
program
    .command('create-asset')
    .description('Create an empty asset')
    .option('-a, --alias <alias>', 'DID alias')
    .option('-r, --registry <registry>', 'registry to use')
    .action(async (options) => {
        try {
            const { alias, registry } = options;
            const did = await keymaster.createAsset({}, { alias, registry });
            console.log(did);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('create-asset-json <file>')
    .description('Create an asset from a JSON file')
    .option('-a, --alias <alias>', 'DID alias')
    .option('-r, --registry <registry>', 'registry to use')
    .action(async (file, options) => {
        try {
            const { alias, registry } = options;
            const data = JSON.parse(fs.readFileSync(file).toString());
            const did = await keymaster.createAsset(data, { alias, registry });
            console.log(did);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('create-asset-image <file>')
    .description('Create an asset from an image file')
    .option('-a, --alias <alias>', 'DID alias')
    .option('-r, --registry <registry>', 'registry to use')
    .action(async (file, options) => {
        try {
            const { alias, registry } = options;
            const data = fs.readFileSync(file);
            const did = await keymaster.createImage(data, { alias, registry });
            console.log(did);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('create-asset-document <file>')
    .description('Create an asset from a document file')
    .option('-a, --alias <alias>', 'DID alias')
    .option('-r, --registry <registry>', 'registry to use')
    .action(async (file, options) => {
        try {
            const { alias, registry } = options;
            const data = fs.readFileSync(file);
            const filename = path.basename(file);
            const did = await keymaster.createDocument(data, { filename, alias, registry });
            console.log(did);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('get-asset <id>')
    .description('Get asset by name or DID')
    .action(async (id) => {
        try {
            const asset = await keymaster.resolveAsset(id);
            console.log(JSON.stringify(asset, null, 4));
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('update-asset-json <id> <file>')
    .description('Update an asset from a JSON file')
    .action(async (id, file) => {
        try {
            const data = JSON.parse(fs.readFileSync(file).toString());
            const ok = await keymaster.updateAsset(id, data);
            console.log(ok ? UPDATE_OK : UPDATE_FAILED);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('update-asset-image <id> <file>')
    .description('Update an asset from an image file')
    .action(async (id, file) => {
        try {
            const data = fs.readFileSync(file);
            const ok = await keymaster.updateImage(id, data);
            console.log(ok ? UPDATE_OK : UPDATE_FAILED);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('update-asset-document <id> <file>')
    .description('Update an asset from a document file')
    .action(async (id, file) => {
        try {
            const data = fs.readFileSync(file);
            const filename = path.basename(file);
            const ok = await keymaster.updateDocument(id, data, { filename });
            console.log(ok ? UPDATE_OK : UPDATE_FAILED);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('transfer-asset <id> <controller>')
    .description('Transfer asset to a new controller')
    .action(async (id, controller) => {
        try {
            const ok = await keymaster.transferAsset(id, controller);
            console.log(ok ? UPDATE_OK : UPDATE_FAILED);
        } catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('clone-asset <id>')
    .description('Clone an asset')
    .option('-a, --alias <alias>', 'DID alias')
    .option('-r, --registry <registry>', 'registry to use')
    .action(async (id, options) => {
        try {
            const { alias, registry } = options;
            const did = await keymaster.cloneAsset(id, { alias, registry });
            console.log(did);
        } catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('set-property <id> <key> [value]')
    .description('Assign a key-value pair to an asset')
    .action(async (id, key, value) => {
        try {
            const data = await keymaster.resolveAsset(id) as Record<string, unknown>;

            if (value) {
                try {
                    data[key] = JSON.parse(value);
                }
                catch {
                    data[key] = value;
                }
            }
            else {
                delete data[key];
            }

            const ok = await keymaster.updateAsset(id, data);
            console.log(ok ? UPDATE_OK : UPDATE_FAILED);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('list-assets')
    .description('List assets owned by current ID')
    .action(async () => {
        try {
            const assets = await keymaster.listAssets();
            console.log(JSON.stringify(assets, null, 4));
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

// Poll commands
program
    .command('create-poll-template')
    .description('Create a poll template')
    .action(async () => {
        try {
            const template = await keymaster.pollTemplate();
            console.log(JSON.stringify(template, null, 4));
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('create-poll <file>')
    .description('Create a poll')
    .option('-a, --alias <alias>', 'DID alias')
    .option('-r, --registry <registry>', 'registry to use')
    .action(async (file, options) => {
        try {
            const { alias, registry } = options;
            const poll = JSON.parse(fs.readFileSync(file).toString());
            const did = await keymaster.createPoll(poll, { alias, registry });
            console.log(did);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('view-poll <poll>')
    .description('View poll details')
    .action(async (poll) => {
        try {
            const response = await keymaster.viewPoll(poll);
            console.log(JSON.stringify(response, null, 4));
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('vote-poll <poll> <vote> [spoil]')
    .description('Vote in a poll')
    .action(async (poll, vote, spoil) => {
        try {
            const did = await keymaster.votePoll(poll, vote, spoil);
            console.log(did);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('update-poll <ballot>')
    .description('Add a ballot to the poll')
    .action(async (ballot) => {
        try {
            const ok = await keymaster.updatePoll(ballot);
            console.log(ok ? UPDATE_OK : UPDATE_FAILED);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('publish-poll <poll>')
    .description('Publish results to poll, hiding ballots')
    .action(async (poll) => {
        try {
            const ok = await keymaster.publishPoll(poll);
            console.log(ok ? UPDATE_OK : UPDATE_FAILED);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('reveal-poll <poll>')
    .description('Publish results to poll, revealing ballots')
    .action(async (poll) => {
        try {
            const ok = await keymaster.publishPoll(poll, { reveal: true });
            console.log(ok ? UPDATE_OK : UPDATE_FAILED);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('unpublish-poll <poll>')
    .description('Remove results from poll')
    .action(async (poll) => {
        try {
            const ok = await keymaster.unpublishPoll(poll);
            console.log(ok ? UPDATE_OK : UPDATE_FAILED);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

// Vault commands
program
    .command('create-vault')
    .description('Create a vault')
    .option('-a, --alias <alias>', 'DID alias')
    .option('-r, --registry <registry>', 'registry to use')
    .option('-s, --secretMembers', 'keep member list secret from each other')
    .action(async (options) => {
        try {
            const did = await keymaster.createVault(options);
            console.log(did);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('list-vault-items <id>')
    .description('List items in the vault')
    .action(async (id) => {
        try {
            const items = await keymaster.listVaultItems(id);
            console.log(JSON.stringify(items, null, 4));
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('add-vault-member <id> <member>')
    .description('Add a member to a vault')
    .action(async (id, member) => {
        try {
            const ok = await keymaster.addVaultMember(id, member);
            console.log(ok ? UPDATE_OK : UPDATE_FAILED);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('remove-vault-member <id> <member>')
    .description('Remove a member from a vault')
    .action(async (id, member) => {
        try {
            const ok = await keymaster.removeVaultMember(id, member);
            console.log(ok ? UPDATE_OK : UPDATE_FAILED);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('list-vault-members <id>')
    .description('List members of a vault')
    .action(async (id) => {
        try {
            const members = await keymaster.listVaultMembers(id);
            console.log(JSON.stringify(members, null, 4));
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('add-vault-item <id> <file>')
    .description('Add an item (file) to a vault')
    .action(async (id, file) => {
        try {
            const data = fs.readFileSync(file);
            const name = path.basename(file);
            const ok = await keymaster.addVaultItem(id, name, data);
            console.log(ok ? UPDATE_OK : UPDATE_FAILED);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('remove-vault-item <id> <item>')
    .description('Remove an item from a vault')
    .action(async (id, item) => {
        try {
            const ok = await keymaster.removeVaultItem(id, item);
            console.log(ok ? UPDATE_OK : UPDATE_FAILED);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('get-vault-item <id> <item> <file>')
    .description('Save an item from a vault to a file')
    .action(async (id, item, file) => {
        try {
            const data = await keymaster.getVaultItem(id, item);
            if (data) {
                fs.writeFileSync(file, data);
                console.log(`Data written to ${file}`);
            } else {
                console.error(`Item ${item} not found in vault`);
            }
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

// Dmail commands
program
    .command('create-dmail <file>')
    .description('Create a new dmail from a JSON file')
    .option('-a, --alias <alias>', 'DID alias')
    .option('-r, --registry <registry>', 'registry to use')
    .action(async (file, options) => {
        try {
            const { alias, registry } = options;
            const message = JSON.parse(fs.readFileSync(file).toString());
            const did = await keymaster.createDmail(message, { alias, registry });
            console.log(did);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('update-dmail <did> <file>')
    .description('Update an existing dmail from a JSON file')
    .action(async (did, file) => {
        try {
            const message = JSON.parse(fs.readFileSync(file).toString());
            const ok = await keymaster.updateDmail(did, message);
            console.log(ok ? UPDATE_OK : UPDATE_FAILED);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('send-dmail <did>')
    .description('Send a dmail and return the notice DID')
    .action(async (did) => {
        try {
            const notice = await keymaster.sendDmail(did);
            if (notice) {
                console.log(notice);
            } else {
                console.error('Send failed');
            }
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('get-dmail <did>')
    .description('Get a dmail message by DID')
    .action(async (did) => {
        try {
            const message = await keymaster.getDmailMessage(did);
            if (message) {
                console.log(JSON.stringify(message, null, 4));
            } else {
                console.error('Dmail not found');
            }
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('list-dmail')
    .description('List dmails for current ID')
    .action(async () => {
        try {
            const dmails = await keymaster.listDmail();
            console.log(JSON.stringify(dmails, null, 4));
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('file-dmail <did> <tags>')
    .description('Assign tags to a dmail (comma-separated, e.g. inbox,unread)')
    .action(async (did, tags) => {
        try {
            const tagList = tags.split(',').map((t: string) => t.trim());
            const ok = await keymaster.fileDmail(did, tagList);
            console.log(ok ? UPDATE_OK : UPDATE_FAILED);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('refresh-dmail')
    .description('Check for new dmails and clean up expired notices')
    .action(async () => {
        try {
            const ok = await keymaster.refreshNotices();
            console.log(ok ? UPDATE_OK : UPDATE_FAILED);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('import-dmail <did>')
    .description('Import a dmail into inbox with unread tag')
    .action(async (did) => {
        try {
            const ok = await keymaster.importDmail(did);
            console.log(ok ? UPDATE_OK : UPDATE_FAILED);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('remove-dmail <did>')
    .description('Delete a dmail')
    .action(async (did) => {
        try {
            const ok = await keymaster.removeDmail(did);
            console.log(ok ? UPDATE_OK : UPDATE_FAILED);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('add-dmail-attachment <did> <file>')
    .description('Add a file attachment to a dmail')
    .action(async (did, file) => {
        try {
            const data = fs.readFileSync(file);
            const name = path.basename(file);
            const ok = await keymaster.addDmailAttachment(did, name, data);
            console.log(ok ? UPDATE_OK : UPDATE_FAILED);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('remove-dmail-attachment <did> <name>')
    .description('Remove an attachment from a dmail')
    .action(async (did, name) => {
        try {
            const ok = await keymaster.removeDmailAttachment(did, name);
            console.log(ok ? UPDATE_OK : UPDATE_FAILED);
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('get-dmail-attachment <did> <name> <file>')
    .description('Save a dmail attachment to a file')
    .action(async (did, name, file) => {
        try {
            const data = await keymaster.getDmailAttachment(did, name);
            if (data) {
                fs.writeFileSync(file, data);
                console.log(`Data written to ${file}`);
            } else {
                console.error(`Attachment ${name} not found`);
            }
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

program
    .command('list-dmail-attachments <did>')
    .description('List attachments of a dmail')
    .action(async (did) => {
        try {
            const attachments = await keymaster.listDmailAttachments(did);
            console.log(JSON.stringify(attachments, null, 4));
        }
        catch (error: any) {
            console.error(error.error || error.message || error);
        }
    });

// Initialize and run
async function run() {
    // Handle --help and --version without full initialization
    if (process.argv.includes('--help') || process.argv.includes('-h') ||
        process.argv.includes('--version') || process.argv.includes('-V') ||
        process.argv.length <= 2) {
        program.parse(process.argv);
        return;
    }

    const gatekeeperURL = process.env.ARCHON_GATEKEEPER_URL || 'http://localhost:4224';
    const walletPath = process.env.ARCHON_WALLET_PATH || './wallet.json';
    const walletType = process.env.ARCHON_WALLET_TYPE || 'json';
    const passphrase = process.env.ARCHON_PASSPHRASE;
    const defaultRegistry = process.env.ARCHON_DEFAULT_REGISTRY;

    if (!passphrase) {
        console.error('Error: ARCHON_PASSPHRASE environment variable is required');
        console.error('Set it with: export ARCHON_PASSPHRASE=your-passphrase');
        process.exit(1);
    }

    try {
        // Initialize gatekeeper client
        const gatekeeper = new GatekeeperClient();
        await gatekeeper.connect({
            url: gatekeeperURL,
            waitUntilReady: true,
            intervalSeconds: 3,
            chatty: false,
            becomeChattyAfter: 2
        });

        // Initialize wallet
        let wallet;
        if (walletType === 'sqlite') {
            wallet = await WalletSQLite.create(walletPath);
        } else {
            // WalletJson expects (filename, folder) - parse the path
            const walletDir = path.dirname(walletPath);
            const walletFile = path.basename(walletPath);
            wallet = new WalletJson(walletFile, walletDir);
        }

        // Initialize cipher
        const cipher = new CipherNode();

        // For commands that need an existing wallet, verify it exists
        const walletCreationCommands = ['create-wallet', 'new-wallet', 'import-wallet', 'restore-wallet-file'];
        const commandName = process.argv[2];
        if (commandName && !walletCreationCommands.includes(commandName)) {
            const existing = await wallet.loadWallet();
            if (!existing) {
                console.error(`Error: Wallet not found at ${walletPath}`);
                console.error('Set ARCHON_WALLET_PATH or ensure wallet.json exists in the current directory.');
                console.error('To create a new wallet, run: keymaster create-wallet');
                process.exit(1);
            }
        }

        // Initialize keymaster
        keymaster = new Keymaster({ gatekeeper, wallet, cipher, defaultRegistry, passphrase });

        program.parse(process.argv);
    }
    catch (error: any) {
        console.error('Failed to initialize:', error.message || error);
        process.exit(1);
    }
}

run();

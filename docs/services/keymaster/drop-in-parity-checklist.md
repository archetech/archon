# Keymaster Drop-In Parity Checklist

This checklist tracks the work required for the Python keymaster library and
service to become a complete drop-in replacement for the canonical TypeScript
implementation.

Source of truth:

- Service contract: `services/keymaster/server/src/keymaster-api.ts`
- Client contract: `packages/keymaster/src/keymaster-client.ts`
- Behavioral coverage: `tests/keymaster/*.test.ts`

## Completion criteria

- [ ] Every TypeScript keymaster HTTP route exists in the Python service with
      matching request body, query params, auth behavior, response envelope,
      and status codes.
- [ ] Every public capability consumed through the TypeScript client contract
      exists in the Python library.
- [ ] Every major TypeScript keymaster test domain has equivalent Python tests.
- [ ] The Python implementation can replace the TypeScript service in compose
      without breaking existing Archon consumers.

## Foundation and runtime

- [x] Python keymaster business logic lives in a reusable library package.
- [x] Python keymaster service is a thin HTTP wrapper over the library.
- [x] Docker and compose support switching between TypeScript and Python
      keymaster implementations.
- [x] Docker smoke tests confirm the currently documented Python runtime
      import path and service entrypoint.

## Wallet

- [x] `loadWallet`
- [x] `saveWallet`
- [x] `newWallet`
- [x] `backupWallet`
- [x] `recoverWallet`
- [x] `checkWallet`
- [x] `fixWallet`
- [x] `decryptMnemonic`
- [x] `exportEncryptedWallet`
- [x] `changePassphrase`
- [ ] Full parity with `tests/keymaster/wallet.test.ts`

## IDs and DID lifecycle

- [x] `listRegistries`
- [x] `listIds`
- [x] `getCurrentId`
- [x] `setCurrentId`
- [x] `createId`
- [x] `createIdOperation`
- [x] `removeId`
- [x] `renameId`
- [x] `backupId`
- [x] `recoverId`
- [x] `resolveDID`
- [x] `updateDID`
- [x] `revokeDID`
- [x] `testAgent`
- [x] `changeRegistry`
- [ ] Full parity with `tests/keymaster/id.test.ts`
- [ ] Full parity with `tests/keymaster/utils.test.ts`

## Aliases

- [x] `addAlias`
- [x] `getAlias`
- [x] `removeAlias`
- [x] `listAliases`
- [ ] Full parity with `tests/keymaster/alias.test.ts`

## Assets

- [x] Library support for `createAsset`
- [x] Library support for `listAssets`
- [x] Library support for `resolveAsset`
- [x] Library support for `mergeData`
- [x] Service route parity for `POST /assets`
- [x] Service route parity for `PUT /assets/:id`
- [x] `cloneAsset`
- [x] `transferAsset`
- [ ] Asset registry-change semantics confirmed against TypeScript behavior
- [ ] Full parity with `tests/keymaster/asset.test.ts`

## Keys and cryptography

- [x] `rotateKeys`
- [x] `encryptMessage`
- [x] `decryptMessage`
- [x] `encryptJSON`
- [x] `decryptJSON`
- [x] `addProof`
- [x] `verifyProof`
- [x] RFC 8785-based JSON canonicalization compatible with the TypeScript
      proof flow
- [ ] Full parity with `tests/keymaster/crypto.test.ts`

## Schemas

- [x] `createSchema`
- [x] `listSchemas`
- [x] `getSchema`
- [x] `setSchema`
- [x] `testSchema`
- [x] `createTemplate`
- [ ] Full parity with `tests/keymaster/schema.test.ts`

## Groups

- [x] `createGroup`
- [x] `getGroup`
- [x] `addGroupMember`
- [x] `removeGroupMember`
- [x] `testGroup`
- [x] `listGroups`
- [ ] Full parity with `tests/keymaster/group.test.ts`

## Challenge and response

- [x] `createChallenge`
- [x] `createResponse`
- [x] `verifyResponse`
- [ ] Full parity with `tests/keymaster/challenge.test.ts`
- [ ] Full parity with `tests/keymaster/response.test.ts`

## Addresses

- [x] `listAddresses`
- [x] `getAddress`
- [x] `importAddress`
- [x] `checkAddress`
- [x] `addAddress`
- [x] `removeAddress`
- [x] Service route parity for `/addresses*`
- [ ] Full parity with `tests/keymaster/address.test.ts`

## Credentials

- [x] `bindCredential`
- [x] `issueCredential`
- [x] `sendCredential`
- [x] `updateCredential`
- [x] `listCredentials`
- [x] `acceptCredential`
- [x] `getCredential`
- [x] `removeCredential`
- [x] `publishCredential`
- [x] `unpublishCredential`
- [x] `listIssued`
- [x] `revokeCredential`
- [x] Service route parity for `/credentials/held*`
- [x] Service route parity for `/credentials/issued*`
- [ ] Full parity with `tests/keymaster/credential.test.ts`

## Polls

- [x] `pollTemplate`
- [x] `createPoll`
- [x] `getPoll`
- [x] `testPoll`
- [x] `listPolls`
- [x] `viewPoll`
- [x] `votePoll`
- [x] `sendPoll`
- [x] `sendBallot`
- [x] `viewBallot`
- [x] `updatePoll`
- [x] `publishPoll`
- [x] `unpublishPoll`
- [x] `addPollVoter`
- [x] `removePollVoter`
- [x] `listPollVoters`
- [x] Service route parity for `/templates/poll` and `/polls*`
- [x] Full parity with `tests/keymaster/poll.test.ts`

## Files and images

- [x] `createImage`
- [x] `updateImage`
- [x] `getImage`
- [x] `testImage`
- [x] `createFile`
- [x] `createFileStream`
- [x] `updateFile`
- [x] `updateFileStream`
- [x] `getFile`
- [x] `testFile`
- [x] Service route parity for image endpoints
- [x] Service route parity for file endpoints
- [x] Full parity with `tests/keymaster/image.test.ts`
- [x] Full parity with `tests/keymaster/file.test.ts`

## Vaults

- [x] `createVault`
- [x] `getVault`
- [x] `testVault`
- [x] `addVaultMember`
- [x] `removeVaultMember`
- [x] `listVaultMembers`
- [x] `addVaultItem`
- [x] `removeVaultItem`
- [x] `listVaultItems`
- [x] `getVaultItem`
- [x] Service route parity for `/vaults*`
- [ ] Full parity with `tests/keymaster/vault.test.ts`

## Dmail and notices

- [x] `listDmail`
- [x] `createDmail`
- [x] `updateDmail`
- [x] `sendDmail`
- [x] `fileDmail`
- [x] `removeDmail`
- [x] `getDmailMessage`
- [x] `listDmailAttachments`
- [x] `addDmailAttachment`
- [x] `removeDmailAttachment`
- [x] `getDmailAttachment`
- [x] `importDmail`
- [x] `createNotice`
- [x] `updateNotice`
- [x] `refreshNotices`
- [x] Service route parity for dmail endpoints
- [x] Service route parity for notice endpoints
- [x] Full parity with `tests/keymaster/dmail.test.ts`
- [x] Full parity with `tests/keymaster/notice.test.ts`

## Nostr

- [x] `addNostr`
- [x] `importNostr`
- [x] `removeNostr`
- [x] `exportNsec`
- [x] `signNostrEvent`
- [x] Service route parity for `/nostr*`
- [ ] Full parity with `tests/keymaster/nostr.test.ts`

## Lightning

- [x] `addLightning`
- [x] `removeLightning`
- [x] `getLightningBalance`
- [x] `createLightningInvoice`
- [x] `payLightningInvoice`
- [x] `checkLightningPayment`
- [x] `decodeLightningInvoice`
- [x] `publishLightning`
- [x] `unpublishLightning`
- [x] `zapLightning`
- [x] `getLightningPayments`
- [x] Service route parity for `/lightning*`
- [ ] Full parity with `tests/keymaster/lightning.test.ts`

## Client and integration parity

- [ ] Python-facing client or compatibility layer covers the same externally
      relevant contract exercised by `tests/keymaster/client.test.ts`
- [ ] Response envelope differences between TypeScript and Python are fully
      removed
- [ ] Compose-level swap test passes with the Python service in place of the
      TypeScript service
- [ ] Cross-service consumers still work: CLI, React wallet, Drawbridge,
      mediators, Herald

## Suggested implementation order

- [x] Finish partial parity in existing domains: wallet passphrase,
      ID registry changes, asset route parity, asset clone and transfer
- [x] Implement credentials
- [x] Implement addresses
- [x] Implement files and images
- [x] Implement polls
- [x] Implement vaults
- [x] Implement dmail and notices
- [x] Implement Nostr
- [x] Implement Lightning
- [ ] Close remaining response-shape and integration gaps
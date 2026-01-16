# Archon (did:cid) DID Scheme


## Abstract

The Archon DID method specification conforms to the requirements specified in the [DID specification](https://www.w3.org/TR/did-core/) currently published by the W3C Credentials Community Group. For more information about DIDs and DID method specifications, please see the [DID Primer](https://w3c-ccg.github.io/did-primer/).

## Introduction

The Archon DID method (`did:cid`) is designed to support a P2P identity layer with secure decentralized [verifiable credentials](https://www.w3.org/TR/vc-data-model-2.0/). Archon DIDs are used for agents (e.g., users, issuers, verifiers, and Archon nodes) and assets (e.g., verifiable credentials, verifiable presentations, schemas, challenges, and responses).

## Archon DID Format

Archon DIDs have the following format:

```
archon-did        = "did:cid:" archon-identifier
                   [ ";" did-service ] [ "/" did-path ]
                   [ "?" did-query ] [ "#" did-fragment ]
archon-identifier = CID v1 in standard base32 encoding
```

### Example: Archon DID

`did:cid:bafkreiawdmk6fmqc5p237vffyctazpzdgvgqfdj2i3hx2idtodxkwhyj5m`

## DID Lifecycle

![](./did-lifecycle.png)

All Archon DIDs begin life anchored to IPFS. Once created they can be used immediately by any application or service connected to an Archon node. Subsequent updates to the DID (meaning that a document associated with the DID changes) are registered on a registry such as a blockchain (BTC, ETH, etc) or a decentralized database (e.g. hyperswarm). The registry is specified at DID creation so that nodes can determine which single source of truth to check for updates.

The *key concept of this design* is that Archon DID creation is decentralized through IPFS, and DID updates are decentralized through the registry specified in the DID creation. The Archon DID is decentralized for its whole lifecycle, which is a hard requirement of DIDs.

## DID Creation

DIDs are anchored to IPFS prior to any declaration on a registry. This allows DIDs to be created very quickly (less than 10 seconds) and at (virtually) no cost.

Archon DIDs support two main types of DID Subject: **agents** and **assets**. Agents have keys and control assets. Assets do not have keys, and are controlled by a single agent (the owner of the asset). The two types have slightly different creation methods.

### Agents

To create an agent DID, the Archon client must sign and submit a "create" operation to the Archon node. This operation will be used to anchor the DID in IPFS.

1. Generate a new private key
    1. We recommend deriving a new private key from an Hierarchical Deterministic (HD) wallet (BIP-32).
1. Generate a public key from the private key
1. Convert to JWK (JSON Web Key) format
1. Create a operation object with these fields in any order:
    1. `type`  must be "create"
    1. `registration` metadata includes:
        1. `version`  number, e.g. 1
        1. `type`  must be "agent"
        1. `registry`  (from a list of valid registries, e.g. "BTC", "hyperswarm", etc.)
    1. `publicJwk` is the public key in JWK format
    1. `created` time in ISO format
    1. `blockid` [optional] current block ID on registry (if registry is a blockchain)
1. Sign the JSON with the private key corresponding the the public key (this enables the Archon node to verify that the operation is coming from the owner of the public key)
1. Submit the operation to the Archon node. For example, with a REST API, post the operation to the Archon node's endpoint to create new DIDs (e.g. `/api/v1/did/`)

Example
```json
{
    "type": "create",
    "created": "2026-01-14T19:29:06.924Z",
    "registration": {
        "version": 1,
        "type": "agent",
        "registry": "hyperswarm"
    },
    "publicJwk": {
        "kty": "EC",
        "crv": "secp256k1",
        "x": "LRrQabMIkvGVTA2IRk0JdWCpu57MNGm89nugrBZHo24",
        "y": "KHsWAaidAIGCosDjRYDIk-94793e4xVEL4UwFxjWgB8"
    },
    "signature": {
        "signed": "2026-01-14T19:29:06.927Z",
        "hash": "59173cb6beec2a1d9c4ca02ba78269999244cf402ae1d4a63c6687f7ddf397ec",
        "value": "a8d4f4121b688c3c4e24187bd6975d9969cc85aad0649c4e7a55bbd5e8457ee66aaea3e5b37db348fe1b0f60b260d12f017489440fb75f90f0475bc75724cf1f"
    }
}
```

Upon receiving the operation the Archon node must:
1. Verify the signature
1. Apply JSON canonicalization scheme to the operation.
1. Pin the seed object to IPFS.

The resulting content address (CID) in standard CID v1 base32 encoding is used as the Archon DID suffix. For example the operation above corresponds to CID "bafkreig6rjxbv2aopv47dgxhnxepqpb4yrxf2nvzrhmhdqthojfdxuxjbe" yielding the Archon DID `did:cid:bafkreig6rjxbv2aopv47dgxhnxepqpb4yrxf2nvzrhmhdqthojfdxuxjbe`.

### Assets

To create an asset DID, the Archon client must sign and submit a `create` operation to the Archon node. This operation will be used to anchor the DID in IPFS.

1. Create a operation object with these fields in any order:
    1. `type`  must be "create"
    1. `registration` metadata includes:
        1. `version`  number, e.g. 1
        1. `type`  must be "agent"
        1. `registry`  (from a list of valid registries, e.g. "BTC", "hyperswarm", etc.)
    1. `controller` specifies the DID of the owner/controller of the new DID
    1. `data` can contain any data in JSON format, as long as it is not empty
    1. `created` time in ISO format
    1. `blockid` [optional] current block ID on registry (if registry is a blockchain)
1. Sign the JSON with the private key of the controller
1. Submit the operation to the Archon node. For example, with a REST API, post the operation to the Archon node's endpoint to create new DIDs (e.g. `/api/v1/did/`)

Example
```json
{
    "type": "create",
    "created": "2026-01-14T19:32:24.354Z",
    "registration": {
        "version": 1,
        "type": "asset",
        "registry": "hyperswarm"
    },
    "controller": "did:cid:bagaaieradidcs4hohalzexldr5mdmbmt553tqq3ifqd56mvhifppvyfdc32q",
    "data": {
        "group": {
            "name": "testgroup",
            "members": []
        }
    },
    "signature": {
        "signer": "did:cid:bagaaieradidcs4hohalzexldr5mdmbmt553tqq3ifqd56mvhifppvyfdc32q",
        "signed": "2026-01-14T19:32:24.375Z",
        "hash": "3c9a93528dc7564903a88bd271ac30afa565f297b7dc3fa90db2dfb3821d7734",
        "value": "34640c06ae6f7a72768b8177f94a34a7fac4025634cebf9825e4d3bbbbd4959d0d7f2aa2ac83c84861b2bc294f90ac1bec0ba7dcd1fb109bcb21fb605f033a91"
    }
}
```

Upon receiving the operation the Archon node must:
1. Verify the signature is valid for the specified controller.
1. Apply JSON canonicalization scheme to the operation object.
1. Pin the seed object to IPFS.

For example, the operation above that specifies an empty Credential asset corresponds to CID "z3v8AuahaEdEZrY9BGfu4vntYjQECBvDHqCG3mPAfEbn6No7AHh" yielding a DID of `did:cid:z3v8AuahaEdEZrY9BGfu4vntYjQECBvDHqCG3mPAfEbn6No7AHh`.

# DID Update

A DID Update is a change to any of the documents associated with the DID. To initiate an update the Archon client must sign a operation that includes the following fields:

1. Create a operation object with these fields in any order:
    1. `type` must be set to "update"
    1. `did` specifies the DID
    1. `doc` is set to the new version of the document set, which must include any or all of:
        1. `didDocument` the main document
        1. `didDocumentData` the document's data
        1. `didDocumentRegistration` the Archon protocol spec
    1. `previd` the CID of the previous operation
    1. `blockid` [optional] current block ID on registry (if registry is a blockchain)
1. Sign the JSON with the private key of the controller of the DID
1. Submit the operation to the Archon node. For example, with a REST API, post the operation to the Archon node's endpoint to update DIDs (e.g. `/api/v1/did/`)

It is recommended the client fetches the current version of the document and metadata, makes changes to it, then submit the new version in an update operation in order to preserve the fields that shouldn't change.

Example update to rotate keys for an agent DID:
```json
{
    "type": "update",
    "did": "did:cid:bagaaieradidcs4hohalzexldr5mdmbmt553tqq3ifqd56mvhifppvyfdc32q",
    "previd": "bagaaieradidcs4hohalzexldr5mdmbmt553tqq3ifqd56mvhifppvyfdc32q",
    "doc": {
        "didDocument": {
            "@context": [
                "https://www.w3.org/ns/did/v1"
            ],
            "id": "did:cid:bagaaieradidcs4hohalzexldr5mdmbmt553tqq3ifqd56mvhifppvyfdc32q",
            "verificationMethod": [
                {
                    "id": "#key-2",
                    "controller": "did:cid:bagaaieradidcs4hohalzexldr5mdmbmt553tqq3ifqd56mvhifppvyfdc32q",
                    "type": "EcdsaSecp256k1VerificationKey2019",
                    "publicKeyJwk": {
                        "kty": "EC",
                        "crv": "secp256k1",
                        "x": "hrpjLquejw7lOE2RVGr1LQ315k0JI1lwlI4WI3t983k",
                        "y": "G2_-Agy95QnIFzW5sa9Ik72vDPeqJ0rqqrxWs3CM49o"
                    }
                }
            ],
            "authentication": [
                "#key-2"
            ]
        }
    },
    "signature": {
        "signer": "did:cid:bagaaieradidcs4hohalzexldr5mdmbmt553tqq3ifqd56mvhifppvyfdc32q",
        "signed": "2026-01-14T19:29:16.117Z",
        "hash": "5aa9c86ca0b269f6e7a7257357214147af06ce971d4d7642c8da3a6e468cd085",
        "value": "2c490cf4d1b694e016b3494655cb418eab3675e8a6c6c9d0567c2c11353c99577e651ce79bd83fd3dc48b3120cd81df2d80dc36e1d1a469e44fed15e81980181"
    }
}
```

Upon receiving the operation the Archon node must:
1. Verify the signature is valid for the controller of the DID.
1. Verify the previd is identical to the latest version's operation CID.
1. Record the operation on the DID specified registry (or forward the request to a trusted node that supports the specified registry).

For registries such as BTC with non-trivial transaction costs, it is expected that update operations will be placed in a queue, then registered periodically in a batch in order to balance costs and latency of updates. If the registry has trivial transaction costs, the update operation may be distributed individually and immediately. Archon defers this tradeoff between cost, speed, and security to the node operators.

## DID Revocation

Revoking a DID is a special kind of Update that results in the termination of the DID. Revoked DIDs cannot be updated because they have no current controller, therefore they cannot be recovered once revoked. Revoked DIDs can be resolved without error, but resolvers will return a document set with the `didMetada.deactivated` property set to `true`. The `didDocument` and `didDocumentData` properties will be set to empty.

To revoke a DID, the Archon client must sign and submit a `delete` operation to the Archon node.

1. Create a operation object with these fields in any order:
    1. `type`  must be "delete"
    1. `did` specifies the DID to be deleted
    1. `previd` the CID of the previous operation
    1. `blockid` [optional] current block ID on registry (if registry is a blockchain)
1. Sign the JSON with the private key of the controller of the DID
1. Submit the operation to the Archon node. For example, with a REST API, post the operation to the Archon node's DID endpoint (e.g. `POST /api/v1/did/`)


Example deletion operation:
```json
{
    "type": "delete",
    "did": "did:cid:bagaaiera7vfnrxrmcvo7prrbmdhpvusroii4y2gir252nzk4jv5nxgkzldha",
    "previd": "bagaaiera7vfnrxrmcvo7prrbmdhpvusroii4y2gir252nzk4jv5nxgkzldha",
    "signature": {
        "signer": "did:cid:bagaaieradidcs4hohalzexldr5mdmbmt553tqq3ifqd56mvhifppvyfdc32q",
        "signed": "2026-01-14T19:34:32.170Z",
        "hash": "4c286b598e3ebf3a7952c52c130261882871a467cad0e8edf7e27217827c6451",
        "value": "6144e8b8f9a11c34ae7f489f62538e077730580e6edcaa60e6a6a780cb6b80373013622696d62f60dbe016f2ec84383632424435a2c5864e4f6a23cf30472377"
    }
}
```

Upon receiving the operation the Archon node must:
1. Verify the signature is valid for the controller of the DID.
1. Verify the previd is identical to the latest version's operation CID.
1. Record the operation on the DID specified registry (or forward the request to a trusted node that supports the specified registry).

After revocation is confirmed on the DID's registry, resolving the DID will result in response like this:
```json
{
    "didDocument": {
        "id": "did:cid:bagaaiera7vfnrxrmcvo7prrbmdhpvusroii4y2gir252nzk4jv5nxgkzldha"
    },
    "didDocumentMetadata": {
        "deactivated": true,
        "created": "2026-01-14T19:32:24Z",
        "deleted": "2026-01-14T19:34:33Z",
        "versionId": "bagaaierats6ttxvpx2l3tat25ota7z7335akfd2iup5loajsdlqcwismkgpq",
        "version": "2",
        "confirmed": true,
        "isOwned": false
    },
    "didDocumentData": {},
    "didDocumentRegistration": {
        "version": 1,
        "type": "asset",
        "registry": "hyperswarm"
    },
    "didResolutionMetadata": {
        "retrieved": "2026-01-14T19:36:09.115Z"
    }
}
```

The metadata has a deactivated field set to true to conform to the [W3C specification](https://www.w3.org/TR/did-core/#did-document-metadata).

## DID Resolution

Resolution is the operation of responding to a DID with a DID Document. If you think of the DID as a secure reference or pointer, then resolution is equivalent to dereferencing.

Given a DID and an optional resolution time, the resolver retrieves the associated document seed from IPFS using the DID suffix as the CID, parsing it as plaintext JSON.
If the data cannot be retrieved, then the resolver should delegate the resolution request to a fallback node.
Otherwise, if the data can be retrieved but is not a valid Archon seed document, an error is returned immediately.
Once returned and validated, the resolver then evaluates the JSON to determine whether it is a known type (an agent or an asset). If it is not a known type an error is returned.

If we get this far, the resolver then looks up the DID's specified registry in its document seed. If the node does not support the registry (meaning the node is not actively monitoring the registry for updates), then it must forward the resolution request to a trusted node that does support the registry. If the node is not configured with any trusted nodes for the specified registry, then it must forward the request to a trusted fallback node to handle unknown registries.

If the node does support the specified registry, the resolver retrieves all update records from its local database that are keyed to the DID, and ordered by each update's ordinal key. The ordinal key is a set of values that can be used to sort the updates into chronological order. For example, the ordinal key for the BTC registry will be a tuple `{block index, transaction index, batch index}`.

The document is then generated by creating an initial version of the document from the document seed, then applying valid updates. In the case of an agent DID, a new DID document is created that includes the public key and the DID as the initial controller. In the case of the asset, a new DID document is created that references the controller and includes the asset data in the document metadata.

If there are any update operations, each one is validated by:

1. verifying that it is signed by the controller of the DID at the time the update was created,
1. verifying that the previous version hash in the operation is identical to the hash of the document set that it is updating,
1. verifying the new version is a valid DID document (schema validation).

If invalid, the update is ignored, otherwise it is applied to the previous document in sequence up to the specified resolution time (if specified) or to the end of the sequence (if no resolution time is specified). The resulting DID document is returned to the requestor.

In pseudo-code:

```
function resolveDid(did, versionTime=now):
    get suffix from did
    use suffix as CID to retrieve document seed from IPFS
    if fail to retrieve the document seed
        forward request to a trusted node
        return
    look up did's registry in its document seed
    if did's registry is not supported by this node
        forward request to a trusted node
        return
    generate initial document from anchor
    retrieve all update operations from did's registry
    for all updates until versionTime:
        if signature is valid and update is valid:
            apply update to DID document
    return DID document
```

## DID Recovery

For security reasons, Archon provides no support for storing private keys. We recommend that Archon clients use BIP-39 to generate a master seed phrase consisting of at least 12 words, and that users safely store the recovery phrase.

If a user loses a device that contains their wallet, they should be able to install the wallet software on a new device, initialize it with their seed phrase and recover their DID along with all their credentials. This implies that a "vault" of the credentials should be stored with the agent DID document, though it should be encrypted with the DID's current private key for privacy.

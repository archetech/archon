---
title: Working with Aliases
sidebar_label: Aliases
slug: aliased-names
---

## What is an alias?

Throughout this documentation, we used "aliases" to facilitate interactions with the archon command. Aliases are stored in the private user wallet and are not communicated or available to other network peers. Aliases can be created for any type of DID (agent or asset) and so can represent other users or various VCs, schemas, etc.

## Adding an alias

Adding an alias will append a new alias to the current user's local wallet:

```sh
$ archon add-alias david "did:cid:z3v8AuabNBnymLADSwWpDJPdEhvt2kS5v7UXypjzPnkqfdnW6ri"
OK
```

## Listing aliases

Listing aliases will reveal the list of aliases stored in the current user's local wallet:

```json
$ archon list-aliases
{
    "vc-social-media": "did:cid:z3v8AuahM2jN3QRaQ5ZWTmzje9HoNdikuAyNjsGfunGfLCGj87J",
    "charlie-homepage": "did:cid:z3v8AuaamvoV6JnvnhJk3E1npohd3jxThPSXFAzZZ4WwzMrirbq",
    "charlie-parent": "did:cid:z3v8Auabi92Gj2gFdrf6JCubbz4RL4auHAD5eZvz8zkAzkeaeHw",
    "req-charlie-homepage": "did:cid:z3v8AuaWxFtpy6Sp5cpHCBQMrsxdMZVdrYTyXMk62p7n5hs4Tb4",
    "david": "did:cid:z3v8AuabNBnymLADSwWpDJPdEhvt2kS5v7UXypjzPnkqfdnW6ri"
}
```

## Removing an alias

Removing an alias will delete an alias from the current user's local wallet:

```sh
$ archon remove-alias david
OK
```

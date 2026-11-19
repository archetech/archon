# @didcid/memeplex

The verifier for [Memeplex](../../docs/plans/memeplex-1436.md), a protocol for publishing on Archon in which every object is a DID.

It is given evidence and returns a verdict. It makes no network requests, so the same code runs in a wallet, a command line and an indexer, and the caller chooses which node's evidence to trust.

## Validity

```js
import { validateObject, validateGrant, validateGrantRequest } from '@didcid/memeplex';

validateObject(data.memeplex);            // 'valid', or the first thing wrong
validateGrant(data.memeplexGrant);
validateGrantRequest(request);
```

Each returns `'valid'`, `'unsupported'` for a `v` this version does not know, or the reason the value is invalid: `'version'`, `'kind'`, `'schema'`, `'rating-bounds'`, `'paper-authors'` or `'expiry-instant'`.

Validity says nothing about who published an object. That is attribution, which is not in this package yet.

## The schemas

`schemas` holds the seven JSON Schemas of `v: 1`. They and the compiled validators in `src` are generated from `share/schema/memeplex/v1`:

```sh
npm run generate -w @didcid/memeplex
```

The validators are compiled when the package is built, not when it is used, so the package runs under a content security policy that forbids building code from strings, and depends on nothing at run time.

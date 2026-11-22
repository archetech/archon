# @didcid/memeplex

The verifier for [Memeplex](../../docs/plans/memeplex-1436.md), a protocol for publishing on Archon in which every object is a DID.

It is given evidence and returns a verdict. It makes no network requests, so the same code runs in a browser, a command line and an indexer, and the caller chooses which node's evidence to trust.

A second entry, `@didcid/memeplex/client`, is what a client does to ask for a grant and publish under it. It is at the end of this page.

## Validity

```js
import { validateObject, validateGrant, validateGrantRequest } from '@didcid/memeplex';

validateObject(data.memeplex);            // 'valid', or the first thing wrong
validateGrant(data.memeplexGrant);
validateGrantRequest(request);
```

Each returns `'valid'`, `'unsupported'` for a `v` this version does not know, or the reason the value is invalid: `'version'`, `'kind'`, `'schema'`, `'rating-bounds'`, `'paper-authors'` or `'expiry-instant'`.

Validity says nothing about who published an object. That is attribution, below.

## Asking for a grant

A client asks by creating a grant request, an asset whose data is `{ "memeplexGrantRequest": { … } }`, and showing a wallet a link that names it.

```js
import { grantLink, parseGrantLink, readGrantRequest } from '@didcid/memeplex';

grantLink(requestDid);                    // 'archon://auth?grant=did:cid:…'
parseGrantLink(text);                     // the DID a link names, or a DID alone; undefined otherwise

const read = readGrantRequest(resolved);  // the request's DID, as a node resolves it
if (!('error' in read)) {
    read.client;                          // who is asking: the request's controller
    read.request;                         // what is asked: name, registries, actions, expiresAt
}
```

`readGrantRequest` gives `error` for a request that is `not-found`, `deactivated`, `not-an-asset`, `invalid-request` (with `validity`) or `changed`. Who asks is the request's controller, and only at its first version: an asset can be given new contents and transferred to an identity that signed nothing, so a later version does not say who asks.

An Archon wallet does not use these. It reads any app's request with Keymaster's own rules, and what Memeplex makes of the grant is for this verifier.

## Grants

```js
import { readGrant, authorityAt } from '@didcid/memeplex';

const grant = readGrant(versions);        // the versions of the grant's DID, as resolved

if (grant.status === 'valid') {
    authorityAt(grant, { block, time }, 'post');   // 'permitted', or why not
}
```

`readGrant` takes the versions a Gatekeeper returns from `POST /api/v1/dids/versions` for the grant's DID. It returns the grant's user, client and registry, the scope in force from each anchored position, and the position at which the grant ended, if it has. A grant that confers nothing is `void` with a reason; one whose creation is not anchored is `pending`.

`authorityAt` says whether a valid grant confers authority at a block of its registry: `'permitted'`, `'before-grant'`, `'after-end'`, `'unordered'`, `'expired'` or `'scope'`. Given a kind, it also checks that the scope in force permits creating that kind.

Neither reads an operation or checks a signature. What each version of a DID is, and where it was anchored, is the Gatekeeper's to say, and the caller chooses which Gatekeeper to trust.

## Attribution

```js
import { attribute } from '@didcid/memeplex';

const publication = attribute(objectVersions, grantVersions);

publication.state;       // 'published', 'withdrawn', 'pending', 'none' or 'unsupported'
publication.memeplex;    // the object to show, when there is one
publication.versions;    // each version's outcome, and why one is not attributed
```

`attribute` takes the versions of the object's DID and the versions of the DID of the grant its creation names. It attributes the longest prefix of versions that pass every check of the plan's rule for publication, and the publication is the last version of that prefix:

| State | Meaning |
|---|---|
| `published` | The last attributed version is a creation or an edit. Show and count `memeplex`. |
| `withdrawn` | The last attributed version is a deletion. A tombstone. |
| `pending` | Nothing is attributed yet, and the creation or its grant is not anchored. Not verified authorship. |
| `none` | The creation is not attributed. No later edit makes it a publication. |
| `unsupported` | The creation states a `v` this version does not know. |

A version that fails a check ends attribution for it and every version after it, and erases nothing before it: an unauthorized deletion or an invalid edit leaves the publication as it was. Each version says why it is not attributed, for example `authority` with `after-end` for one anchored at or after the block that revoked its grant.

The result is a reading of the versions handed over. When either DID changes, attribute again.

## Ratings and coauthors

Two readings over publications that independent indexers have to agree on:

```js
import { currentRatings, ratingValue, coauthors } from '@didcid/memeplex';

currentRatings(publications);            // the rating that counts for each author and target
ratingValue(publication.memeplex);       // from 0 (worst) to 1 (best)
coauthors(paper, tagPublications);       // each listed coauthor: confirmed, confirmed-other or listed
```

- `currentRatings` keeps, for each author and target, the published rating whose shown version was anchored latest by block time; of two anchored at the same time, the one with the smaller version identity. A withdrawn rating does not count.
- `coauthors` says how each coauthor a paper lists stands towards the revision it shows: `confirmed` when an attributed `coauthor` tag of theirs pins that revision, `confirmed-other` with the revisions their tags do pin, and `listed` when there is only the publisher's claim.

## The schemas

`schemas` holds the seven JSON Schemas of `v: 1`. They and the compiled validators in `src` are generated from `share/schema/memeplex/v1`:

```sh
npm run generate -w @didcid/memeplex
```

The validators are compiled when the package is built, not when it is used, so the package runs under a content security policy that forbids building code from strings, and depends on nothing at run time.

## An index

```js
import { MemeplexIndex } from '@didcid/memeplex';

const index = new MemeplexIndex();

index.put(did, versions);           // every version of a DID, as resolved; again whenever it changes

index.holds(did);                   // whether the DID's versions are held; index.dids() lists them
index.publication(did);             // published or withdrawn, or undefined when nothing is attributed
index.timeline([author, ...]);      // posts, papers and replies, newest first
index.thread(target);               // replies and their replies, as a flat list with each one's depth
index.boosts(target);
index.ratings(target);              // the ratings that count, and their mean
index.tags(target);                 // each value with the authors who applied it
index.coauthors(paper);
```

`MemeplexIndex` holds the versions of each object and grant it is handed, and derives every answer from those. It fetches nothing: whoever runs it asks a Gatekeeper which DIDs changed and hands over the versions of each. An object is attributed again when its grant's history arrives or changes.

Because every view is a function of the versions held, an index filled in any order, or filled again from nothing, answers the same as one kept up to date. `snapshot()` returns every publication by DID, for comparing two indexes.

## A client

```js
import { MemeplexClient, IndexerClient, usable, allows } from '@didcid/memeplex/client';

const client = new MemeplexClient({ keymaster, gatekeeper, identity: 'memepool' });

const { did, link } = await client.requestGrant({ name: 'Memepool', registries: ['BTC:mainnet'] });
// show `link` to the user's wallet, then:
const grant = usable(await client.findGrants(did));     // undefined until one grant answers and is anchored

if (grant && allows(grant, 'post')) {
    const post = await client.publish(grant, { kind: 'post', text: 'Hello.' });
    await client.edit(post, grant, { kind: 'post', text: 'Hello, world.' });
    await client.withdraw(post, grant);
}
```

`MemeplexClient` acts through a Keymaster that holds the client's identity and a Gatekeeper it reads from, both handed to it, so this entry adds no dependency. `requestGrant` creates the request, on `hyperswarm` and valid for an hour unless told otherwise. `findGrants` returns each grant that answers a request, as the verifier reads it; `grantsFrom(user)` returns a known user's grants, whatever request they answer. A client checks a kind against the grant's scope with `allows` before it creates anything: an object outside the scope is accepted by the node and never attributed.

The client that publishes an object [pins the content](../../docs/plans/memeplex-reference-1436.md#content-availability) the object references. `publish` and `edit` take a reference as given and do not pin it.

`IndexerClient` reads an indexer over HTTP: whether it is `ready`, a `publication`, a `timeline` and a `thread`.

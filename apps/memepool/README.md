# Memepool pages

The pages of Memepool, the first Memeplex client. A reader signs in with an Archon
wallet, grants the [Memepool service](../../docs/services/memepool/README.md) once,
and then reads the authors they follow and publishes posts and replies.

The pages hold no key. Everything they publish goes to the Memepool service, which
publishes for the user under their grant. Everything they read comes from the
[Memeplex indexer](../../docs/services/memeplex-indexer/README.md).

## What a reader sees

1. **Sign in.** The page shows a challenge as a QR code and a link. The wallet
   answers it, the page says which identity answered, and the reader confirms it is
   theirs. Anyone can answer a challenge, which is why the page asks. A wallet that
   cannot send its answer back gives the reader a response to paste.
2. **Grant.** With no grant, the page shows the grant link for the wallet to approve.
   With a grant made and not yet anchored on its chain, it says so.
3. **Timeline.** The reader's own posts and those of the authors they follow.
4. **Post and reply.** What the reader publishes is shown as waiting until its chain
   anchors it and the indexer has it: it is not a publication before then.
   **An article** is a post with a title, a summary and a body. The body is sent to
   the service, which stores it; a timeline shows the title and summary, and the
   body is read when the article is opened. It is shown as it was written: the page
   does not render Markdown.
5. **Thread.** A post with the replies under it, how many have boosted it, how it is
   rated, and the tags and reactions on it.
6. **Respond.** A boost, a thumb up or down, a like, a tag, each offered only when
   the reader's grant allows it. Each is an object of the
   reader's, about the version of the post that is shown. A reader has one rating of
   an object, so a second thumb changes the first.
7. **Edit and withdraw**, for what the reader published through this service.

Follows are kept in the browser (`localStorage`) and published nowhere, so the
network does not learn whom anyone follows. The indexer does see which authors a
timeline is asked for.

## Running it

```sh
npm ci
npm run dev      # the pages, with the two services expected on the same host
npm test
npm run build    # static files in dist/
```

The pages call the two services on the host they are served from, at Drawbridge's
mounts: `/memepool` and `/memeplex`. `VITE_MEMEPOOL_URL` and `VITE_MEMEPLEX_URL`
change that at build time. The session is a cookie, so the Memepool service has to
be on the pages' own origin.

The build is a set of static files with relative paths, so it can be served from
any path. The Memepool service's image carries them and serves them beside its API,
so a node with the `memepool` profile has the pages at `<node>/memepool/`.

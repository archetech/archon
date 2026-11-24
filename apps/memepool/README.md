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
3. **Timeline.** The reader's own posts and those of the authors they follow. Each post
   has a button that copies its DID, which is its address: what a wallet or another
   node resolves it by.
4. **Post and reply.** What the reader publishes is shown as waiting until its chain
   anchors it and the indexer has it: it is not a publication before then.
   **An article** is a post with a title, a summary and a body. The body is sent to
   the service, which stores it; a timeline shows the title and summary, and the
   body is read when the article is opened.

A boost is shown as what it passes on: the post it is of, as that post is shown
anywhere, under a line saying who boosted it and when. A boost is of one version of
a post, and that version is what is shown, read from the indexer by the version the
boost names: an edit to the post changes nothing in the boost. A post its author has
since withdrawn is still shown, and said to have been withdrawn. Where the version
boosted is no longer in the post's history, which a replay can bring about, no other
version is shown in its place. Opening a boost opens the post as it is, and the
reader who made a boost can undo it, which withdraws the boost and leaves the post.

What a reader publishes is not a publication until its chain anchors it, which can
be minutes or an hour. Until the indexer shows it, the pages show it themselves, as
the reader's post with a mark saying it waits and the chain it waits on. It is kept
in the browser, for each reader, so it is still there when the page is read anew.
The pages ask the Memepool service where each such object stands: one that is
published is put away for the indexer to show, and one that will never be, made
under a grant that ended before it was anchored, says so and is the reader's to
dismiss.

A reader's timeline is the posts, articles and boosts of the reader and of those
they follow. It holds no replies: a reply is part of a conversation, and is read in
the thread of what it answers.

An author, wherever one is shown, is the way to that author's own posts: a list of
what the author published and nothing else, read from the indexer a page at a time,
with the way to follow or unfollow the author and a step back to the reader's
timeline. The author's view has two lists, **Posts** and **Replies**. A reply there
is shown with what it answers above it, as that was at the version answered, since
it is read apart from its thread. A reader's own replies are found the same way, by
going to themselves.

An author is shown by the name the identity gives itself and by its address, where
it has them, with the DID always beside them: a name is a claim anyone can make, and
the service passes on an address only when the address's domain confirms it.

An author's avatar is shown beside each post, beside the reader's own DID and
beside each author followed. It is asked of the Memepool service, which serves the
image an identity names as its avatar; where there is none, the place holds a figure
of a colour worked out from the DID, so that two authors without avatars are still
told apart.

Wherever the reader writes text (a post, a reply, an article's body, an edit) there
are two views, **Write** and **Preview**. The preview is made by what shows a
published entry, so it is what readers will see, an article with its title and
summary above its body.

Text is shown as the protocol says a client shows it: a post, a reply and an
article's body are GitHub Flavored Markdown. It is written by strangers, so HTML in
it is shown as text and never made into elements, a link is followed only to an
`https:` address, and no image is loaded from elsewhere: one at an `https:` address
is a link the reader may follow, since fetching it would tell its host who is
reading. Math is not rendered yet.

An embed is an image whose address is a DID and a version of it,
`![words](did:cid:…?versionId=…)`, and what it shows depends on what the DID is:

- **An object** is shown as a card: who wrote it, when, and what it said at that
  version, whatever it says since, with the way to open it as it is. This is how one
  post quotes another. A card's own embeds are shown by their words, so that no card
  is inside another.
- **An image asset** is shown as the image, which the Memepool service serves.
- **Anything else**, a DID with no version, and an embed in a heading, a table, the
  words of a link or inside emphasis, is shown by its words. So is every embed past the twentieth in
  one text.

A version that is no longer in an object's history is said to be, and no other is
shown in its place. Each post has **Copy embed**, which gives the Markdown that
embeds the version shown; pasted into a post, the preview shows the card.

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

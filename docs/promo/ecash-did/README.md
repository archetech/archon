# How ecash finds a DID

A 70-second, 1920×1080, silent video that follows one Cashu payment from Alice to
Bob through the three things Archon adds to it:

1. **Resolve.** Alice pastes Bob's DID. Her wallet resolves it to his DID document,
   which lists his signing key, his key-agreement key and his DIDComm mailbox.
2. **Lock.** At the mint, her ecash is swapped for ecash only Bob's signing key can
   spend (NUT-11), with a refund to her own key after the time she set.
3. **Send.** The token goes in a DIDComm message, encrypted to Bob's key-agreement
   key and posted to the mailbox his document names.
4. **Collect.** Bob's wallet fetches the message from his mailbox and decrypts it.
5. **Claim.** Bob's wallet signs with the key the ecash is locked to, and the mint
   issues him ecash of his own.

Nothing on screen is mocked up. The phone screens are screenshots of two React
wallets making that payment on the regtest stack in `tests/cashu-regtest`, and the
panels quote values from the same run: Bob's DID document, the token's spending
condition and the DIDComm message as his wallet shows it. `capture.mjs` refuses to
write `data.json` unless the key the token is locked to is the `#key-1` in Bob's
document. The boxes and the markers that travel between them are a diagram.

- `page.html` is the whole video. Every animation is positioned by `window.seek(t)`,
  so a frame depends only on its time.
- `render.mjs` loads the page in headless Chrome and pipes the frames to ffmpeg.
- `capture.mjs` drives the two wallets and writes `screens/` and `data.json`.
- `regtest-host.yml` gives the stack the public name `archon.example`.
- `fonts/` holds Geist and Geist Mono, under the licence beside them.

## Render

Requires Node 22+, ffmpeg, and a Chrome or `chrome-headless-shell` binary. The
screenshots and `data.json` are checked in, so this needs no stack.

```sh
npm install --no-save playwright-core
CHROME=/path/to/chrome node render.mjs video           # → ecash-did.mp4 (~3 min)
CHROME=/path/to/chrome node render.mjs stills 22.5 47  # → still-22.5.png, still-47.png
```

Outputs are git-ignored.

## Record it again

This replaces `screens/` and `data.json` with a new payment between new identities.

```sh
# 1. The regtest stack, left running, under its video name. Building the images
#    takes about half an hour the first time; see tests/cashu-regtest/README.md.
KEEP=1 tests/cashu-regtest/run.sh
docker compose -p cashu-regtest -f tests/cashu-regtest/compose.yml \
    -f docs/promo/ecash-did/regtest-host.yml up -d --no-deps \
    lightning-mediator cashu-mint drawbridge drawbridge-paid-ts drawbridge-paid-py

# 2. The React wallet, from a dev server or a node's wallet container.
(cd apps/react-wallet && VITE_PORT=4238 npm run dev)

# 3. The payment.
cd docs/promo/ecash-did
rm -rf profiles
export CHROME=/path/to/chrome WALLET_URL=http://127.0.0.1:4238
node capture.mjs setup && node capture.mjs send && node capture.mjs claim
```

The wallets are told to use the stack's Drawbridge, whatever serves their pages, so
they never touch another node. `capture.mjs` works from what the wallet shows, and
will need its selectors updated when those screens change.

# Credential Verification Video

A self-contained [Remotion](https://www.remotion.dev/) composition explaining how Archon verifies a credential presentation. It follows the protocol in the Keymaster service specification, [§9.3–9.4](../services/keymaster/README.md#93-challenges-and-responses).

## What it shows

About 2 minutes 20 seconds at 1920×1080, 30 fps. The video has no voice track; on-screen captions carry the narration.

1. **The cast.** Alice issues credentials, Carol holds them, Victor verifies them, and a Gatekeeper ledger holds the DIDs.
2. **Issuance.** A signed credential is encrypted to its holder as an asset DID, with a hash of its plaintext and its own DID in `id`.
3. **Challenge.** The verifier publishes the schema and issuers it will accept.
4. **Response.** The holder re-encrypts the credential's exact plaintext as a presentation carrying the same hash, and lists each credential/presentation pair.
5. **Verification.** The five checks a credential must pass: still live, hashes match, signed by its issuer, lives at its DID, meets a request. Each is shown stopping the forgery it exists for.
6. **Pairing.** Requests and credentials are paired one to one by maximum matching, so the order of credentials never decides the outcome.
7. **Verifying the past.** With `versionTime`, verification reads every DID as it stood at that time. A chain-anchored revocation takes effect at its block's time.
8. **Recap.**

## Preview

```bash
cd docs/remotion-credential-verification
npm install
npm run dev
```

## Render

```bash
cd docs/remotion-credential-verification
npm install
npm run render            # out/credential-verification.mp4
npm run still -- --frame=1500   # a single frame, for checking layout
```

Rendered output goes to `out/`, which is not committed. Scene lengths are exported from each scene module, and `src/Video.tsx` totals them, so a scene can be retimed without editing the composition.

## Layout

- `src/theme.ts`: palette, fonts (Inter and JetBrains Mono via `@remotion/google-fonts`) and the cast
- `src/components.tsx`: shared building blocks such as actors, panels, DID and hash chips, arrows, verdicts and captions
- `src/scenes/`: one module per part of the story
- `src/Video.tsx`: the scene sequence and transitions

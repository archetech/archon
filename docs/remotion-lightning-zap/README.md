# Lightning Zap Remotion Video

This folder contains a self-contained Remotion composition that visualizes the workflow described in [`../lightning-zap-sequence.md`](../lightning-zap-sequence.md).

## What it shows

- Phase 1: recipient resolution in the CLI / Keymaster / Gatekeeper path
- The branch between LUD-16 (`user@domain`) and DID-based zaps
- Phase 2A: LNURL invoice fetch flow
- Phase 2B: DID `#lightning` service invoice fetch flow
- Phase 3: LNbits payment and Lightning Network settlement

## Run it

```bash
cd docs/remotion-lightning-zap
npm install
npm run dev
```

## Render an MP4

```bash
cd docs/remotion-lightning-zap
npm install
npm run render
```

The render script writes the video to `docs/lightning-zap-workflow.mp4`.

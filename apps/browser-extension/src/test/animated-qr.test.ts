import { describe, expect, it } from 'vitest';
import { animatedQrFrames, qrCollector } from '../../../../packages/wallet-ui/src/utils/animatedQr';
import reference from '../../../../tests/fixtures/animated-qr-frames.json';

// The extension gives the UR library sha256 from @noble/hashes 2, where the
// library was written for version 1 (webpack.common.js). The hash seeds the
// fountain-coded frames, so a different result would make frames no other
// wallet could read. The reference frames come from the React wallet's build,
// which uses version 1.
describe('animated QR frames in the extension build', () => {
    it('match the frames the library produces with its own hash function', () => {
        const next = animatedQrFrames(reference.text);
        const frames = Array.from({ length: 80 }, () => next());
        for (const [number, frame] of Object.entries(reference.frames)) {
            expect(frames[Number(number) - 1]).toBe(frame);
        }
    });

    it('are read back from fountain-coded frames alone', () => {
        const next = animatedQrFrames(reference.text);
        const frames = Array.from({ length: 300 }, () => next());
        const collector = qrCollector();
        frames.slice(100).some(frame => collector.accept(frame) >= 1);
        expect(collector.result()).toBe(reference.text);
    });
});

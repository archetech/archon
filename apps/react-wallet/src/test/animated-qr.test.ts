import { Buffer } from 'buffer';
import { describe, expect, it } from 'vitest';
import { UR, URDecoder, UREncoder } from '@gandlaf21/bc-ur';
import { animatedQrFrames, qrCollector } from '../../../../packages/wallet-ui/src/utils/animatedQr';

// Animated QR codes (NUT-16). The frames are checked against the UR library
// used the way another Cashu wallet uses it, since interoperating with those
// wallets is the point.

const TOKEN = `cashuB${'abcdefghij'.repeat(500)}`;

function collect(frames: string[]) {
    const collector = qrCollector();
    let progress = 0;
    for (const frame of frames) {
        progress = collector.accept(frame);
        if (progress >= 1) {
            break;
        }
    }
    return { progress, text: collector.result() };
}

describe('animated QR frames', () => {
    it('are UR parts of a bytes message, in uppercase', () => {
        const next = animatedQrFrames(TOKEN);
        const frames = Array.from({ length: 5 }, () => next());
        for (const frame of frames) {
            expect(frame).toMatch(/^UR:BYTES\/\d+-\d+\/[A-Z]+$/);
        }
        expect(new Set(frames).size).toBe(5);
    });

    it('are read by another wallet’s decoder as the text', () => {
        const next = animatedQrFrames(TOKEN);
        const decoder = new URDecoder();
        for (let i = 0; i < 300 && !decoder.isComplete(); i++) {
            decoder.receivePart(next());
        }
        expect(decoder.isSuccess()).toBe(true);
        expect(Buffer.from(decoder.resultUR().decodeCBOR()).toString()).toBe(TOKEN);
    });

    it('never end, so a scanner can join at any time', () => {
        const next = animatedQrFrames(TOKEN);
        const frames = Array.from({ length: 500 }, () => next());
        expect(collect(frames.slice(300)).text).toBe(TOKEN);
    });

    it('carry text that is not ASCII', () => {
        const text = `${'é☃'.repeat(1500)}`;
        const next = animatedQrFrames(text);
        expect(collect(Array.from({ length: 300 }, () => next())).text).toBe(text);
    });
});

describe('collecting scanned codes', () => {
    it('takes an ordinary code as the text', () => {
        expect(collect(['cashuBshort'])).toEqual({ progress: 1, text: 'cashuBshort' });
    });

    it('reads frames as another wallet sends them, in lowercase and in smaller parts', () => {
        const encoder = new UREncoder(UR.fromBuffer(Buffer.from(TOKEN)), 50, 0);
        const frames = Array.from({ length: 600 }, () => encoder.nextPart());
        expect(frames[0]).toMatch(/^ur:bytes\//);
        expect(collect(frames).text).toBe(TOKEN);
    });

    it('reports progress that rises and reaches 1 only when the text is whole', () => {
        const next = animatedQrFrames(TOKEN);
        const collector = qrCollector();
        const seen: number[] = [];
        while (collector.result() === null) {
            seen.push(collector.accept(next()));
        }
        expect(seen[seen.length - 1]).toBe(1);
        expect(seen.slice(0, -1).every(value => value < 1)).toBe(true);
        expect(seen[Math.floor(seen.length / 2)]).toBeGreaterThan(0);
    });

    it('survives frames that were misread, and parts that are not UR at all', () => {
        const next = animatedQrFrames(TOKEN);
        const frames = Array.from({ length: 300 }, () => next());
        const noisy = frames.flatMap((frame, i) => (i % 7 === 0 ? ['UR:BYTES/1-3/NOTBYTEWORDS', 'ur:', frame] : [frame]));
        expect(collect(noisy).text).toBe(TOKEN);
    });

    it('keeps the first text once complete', () => {
        const collector = qrCollector();
        expect(collector.accept('first')).toBe(1);
        expect(collector.accept('second')).toBe(1);
        expect(collector.result()).toBe('first');
    });

    it('has no text before it is complete', () => {
        const collector = qrCollector();
        expect(collector.accept(animatedQrFrames(TOKEN)())).toBeLessThan(1);
        expect(collector.result()).toBeNull();
    });
});

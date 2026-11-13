import { Buffer } from 'buffer';
import { describe, expect, it, vi } from 'vitest';
import { UR, URDecoder, UREncoder } from '@gandlaf21/bc-ur';
import { animatedQrFrames, qrCollector } from '../../../../packages/wallet-ui/src/utils/animatedQr';
import reference from '../../../../tests/fixtures/animated-qr-frames.json';

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
    // The extension builds the library against another version of the hash
    // function that seeds the coded frames, and checks the same file.
    it('are the same from one build to another, the fountain-coded ones included', () => {
        const next = animatedQrFrames(reference.text);
        const frames = Array.from({ length: 80 }, () => next());
        for (const [number, frame] of Object.entries(reference.frames)) {
            expect(frames[Number(number) - 1]).toBe(frame);
        }
    });

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

    it('drops a part that claims more parts than any token has, without handing it to the decoder', () => {
        const receive = vi.spyOn(URDecoder.prototype, 'receivePart');
        const collector = qrCollector();
        // A real part of a one-part message, relabelled.
        const body = new UREncoder(UR.fromBuffer(Buffer.from('short')), 150).nextPart().split('/').pop();
        for (const claim of ['1-1000000000', '1-2001', '0-5', '1-0', '99999999999-5']) {
            expect(collector.accept(`ur:bytes/${claim}/${body}`)).toBe(0);
        }
        expect(receive).not.toHaveBeenCalled();
        receive.mockRestore();

        const next = animatedQrFrames(TOKEN);
        expect(collect(Array.from({ length: 300 }, () => next())).text).toBe(TOKEN);
    });

    it('ignores a UR of another type, which would otherwise fix the decoder on that type', () => {
        const collector = qrCollector();
        expect(collector.accept('ur:crypto-psbt/notbytewords')).toBe(0);
        expect(collector.accept('UR:CRYPTO-PSBT/1-3/LPADAXCS')).toBe(0);

        const next = animatedQrFrames(TOKEN);
        let progress = 0;
        for (let i = 0; i < 300 && progress < 1; i++) {
            progress = collector.accept(next());
        }
        expect(collector.result()).toBe(TOKEN);
    });

    it('starts again after a message that fails its checksum', async () => {
        const { FountainEncoderPart } = await import('../../node_modules/@gandlaf21/bc-ur/dist/lib/es6/fountainEncoder.js');
        const bytewords = (await import('../../node_modules/@gandlaf21/bc-ur/dist/lib/es6/bytewords.js')).default;
        const encoder = new UREncoder(UR.fromBuffer(Buffer.from(TOKEN)), 150);
        const count = Number(encoder.nextPart().split('/')[1].split('-')[1]);
        const fresh = new UREncoder(UR.fromBuffer(Buffer.from(TOKEN)), 150);
        const frames = Array.from({ length: count }, () => fresh.nextPart());
        // The first part with its data changed and its own checksum made good,
        // so only the message's checksum can catch it.
        const [, sequence, body] = frames[0].split('/');
        const part = FountainEncoderPart.fromCBOR(bytewords.decode(body, bytewords.STYLES.MINIMAL));
        const fragment = Buffer.from(part.fragment);
        fragment[0] ^= 0xff;
        const forged = new FountainEncoderPart(part.seqNum, part.seqLength, part.messageLength, part.checksum, fragment);
        frames[0] = `ur:bytes/${sequence}/${bytewords.encode(forged.cbor().toString('hex'), bytewords.STYLES.MINIMAL)}`;

        const collector = qrCollector();
        const progress = frames.map(frame => collector.accept(frame));
        expect(progress[progress.length - 1]).toBe(0);
        expect(collector.result()).toBeNull();

        const next = animatedQrFrames(TOKEN);
        for (let i = 0; i < 300 && collector.result() === null; i++) {
            collector.accept(next());
        }
        expect(collector.result()).toBe(TOKEN);
    });

    // Whole messages with a valid checksum, whose payload is not the bytes of
    // a text: a CBOR map, and bytes that are not CBOR at all.
    it.each([
        ['a payload that is not a byte string', [0xa0]],
        ['a payload that is not CBOR', [0xff]],
    ])('starts again after %s', (_what, payload) => {
        const collector = qrCollector();
        const whole = new UREncoder(new UR(Buffer.from(payload)), 150).nextPart();
        expect(whole).toMatch(/^ur:bytes\/[a-z]+$/);
        expect(collector.accept(whole)).toBe(0);
        expect(collector.result()).toBeNull();

        const next = animatedQrFrames(TOKEN);
        for (let i = 0; i < 300 && collector.result() === null; i++) {
            collector.accept(next());
        }
        expect(collector.result()).toBe(TOKEN);
    });

    it('keeps what it has when a part in the middle is unusable', () => {
        const next = animatedQrFrames(TOKEN);
        const collector = qrCollector();
        let progress = 0;
        for (let i = 0; i < 10; i++) {
            progress = collector.accept(next());
        }
        expect(progress).toBeGreaterThan(0);
        expect(collector.accept('ur:bytes/3-34/notbytewords')).toBe(progress);
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

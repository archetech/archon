import { Buffer } from "buffer";
import { UR, URDecoder, UREncoder } from "@gandlaf21/bc-ur";

// Animated QR codes (NUT-16): a text too long for one code is sent as a UR
// sequence, one part per frame, which a scanner collects until it has enough.
// The text travels as the bytes of a `ur:bytes` message, as other Cashu wallets
// send it.

// Bytes of the message in each frame. A larger part makes a denser code, which
// a camera reads less reliably off a screen.
const FRAGMENT_BYTES = 150;
// How long each frame is shown.
export const FRAME_MS = 200;

// Returns the frames of `text`, one on each call, without end: after one pass
// the parts are fountain-coded, so a scanner that missed one need not wait for
// it to come round again. Uppercase, since a QR code packs that more tightly.
export function animatedQrFrames(text: string): () => string {
    const encoder = new UREncoder(UR.fromBuffer(Buffer.from(text, "utf8")), FRAGMENT_BYTES);
    return () => encoder.nextPart().toUpperCase();
}

export interface QrCollector {
    // Takes one scanned code and returns how complete the text is, from 0 to 1.
    accept(scanned: string): number;
    // The text, once accept has returned 1.
    result(): string | null;
}

// A part of a `ur:bytes` message: alone, or numbered within a sequence. Other
// UR types are not text, and the decoder commits to the type of the first part
// it is given, so one must never reach it.
const UR_PART = /^ur:bytes\/(?:(\d{1,9})-(\d{1,9})\/)?[a-z]+$/;
// The decoder allocates for as many parts as a frame claims the message has.
// At the smallest part other wallets send, this is still a far longer text
// than a token.
const MAX_PARTS = 2000;

// Collects what a camera reads into one text. An ordinary code is the text; a
// UR part is one frame of an animated code. What a camera reads is whatever is
// in front of it, so a part that cannot belong to a token is dropped, and a
// message that fails starts collection again.
export function qrCollector(): QrCollector {
    let decoder = new URDecoder();
    let text: string | null = null;
    return {
        accept(scanned: string): number {
            if (text !== null) {
                return 1;
            }
            if (!/^ur:/i.test(scanned)) {
                text = scanned;
                return 1;
            }
            const part = UR_PART.exec(scanned.toLowerCase());
            const count = part?.[2] === undefined ? 1 : Number(part[2]);
            if (!part || count < 1 || count > MAX_PARTS || Number(part[1] ?? 1) < 1) {
                return 0;
            }
            try {
                decoder.receivePart(part[0]);
            }
            catch {
                // Not a part this decoder can use. What it has stays.
            }
            if (decoder.isSuccess()) {
                try {
                    // The bytes come back as a Buffer or a plain Uint8Array,
                    // depending on the platform.
                    const bytes: unknown = decoder.resultUR().decodeCBOR();
                    if (bytes instanceof Uint8Array) {
                        text = new TextDecoder().decode(bytes);
                        return 1;
                    }
                }
                catch {
                    // A whole message whose payload is not CBOR.
                }
            }
            else if (!decoder.isError()) {
                // Never 1 before the checksum has passed.
                return Math.min(decoder.estimatedPercentComplete(), 0.99);
            }
            // The message failed its checksum, or was not a byte string. A
            // decoder that has finished takes no more parts, so nothing further
            // could come of it.
            decoder = new URDecoder();
            return 0;
        },
        result: () => text,
    };
}

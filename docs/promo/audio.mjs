// Every sample of the soundtrack is computed here: no recordings, no samples.
// 128 bpm, 16 bars = 30 s, A minor (Am - F - C - G), 48 kHz stereo.
import { writeFileSync } from 'node:fs';

const SR = 48000, BPM = 128, BEAT = 60 / BPM, BAR = BEAT * 4, BARS = 16;
const LEN = Math.ceil(30 * SR) + SR; // a second of tail
const L = new Float32Array(LEN), R = new Float32Array(LEN);
const revL = new Float32Array(LEN), revR = new Float32Array(LEN); // reverb send

let seed = 1;
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
const add = (i, l, r, send = 0) => { if (i >= 0 && i < LEN) { L[i] += l; R[i] += r; revL[i] += l * send; revR[i] += r * send; } };

// Chords per bar: roots and triads (MIDI). Am F C G.
const CHORDS = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]];
const chordAt = bar => CHORDS[bar % 4];

// Section boundaries (in bars) matching the picture.
const S = { beat: 2, arp: 5, full: 8, accel: 11, end: 14 };

// --- instruments ---------------------------------------------------------
function kick(t, gain = 1) {
    const s = Math.floor(t * SR), n = Math.floor(0.45 * SR);
    let ph = 0;
    for (let i = 0; i < n; i++) {
        const x = i / SR;
        const f = 45 + 110 * Math.exp(-x / 0.035);
        ph += 2 * Math.PI * f / SR;
        const env = Math.exp(-x / 0.16);
        const click = i < 180 ? (1 - i / 180) * 0.35 * rand() : 0;
        const v = (Math.sin(ph) * env + click) * 0.9 * gain;
        add(s + i, v, v);
    }
}
function hat(t, gain = 0.18, decay = 0.035, pan = 0.2) {
    const s = Math.floor(t * SR), n = Math.floor(decay * 6 * SR);
    let lp = 0;
    for (let i = 0; i < n; i++) {
        const w = rand(); lp += 0.35 * (w - lp);
        const v = (w - lp) * Math.exp(-i / SR / decay) * gain;
        add(s + i, v * (1 - pan), v * (1 + pan), 0.05);
    }
}
function clap(t, gain = 0.32) {
    const s = Math.floor(t * SR), n = Math.floor(0.35 * SR);
    let lp = 0, bp = 0;
    for (let i = 0; i < n; i++) {
        const x = i / SR;
        const w = rand(); lp += 0.45 * (w - lp); bp += 0.25 * ((w - lp) - bp);
        const bursts = x < 0.03 ? 0.6 + 0.4 * Math.cos(x * 2 * Math.PI * 100) : 1;
        const v = bp * Math.exp(-x / 0.09) * bursts * gain * 2.4 + Math.sin(2 * Math.PI * 185 * x) * Math.exp(-x / 0.04) * gain * 0.5;
        add(s + i, v, v, 0.25);
    }
}
// Sawtooth through a one-pole low-pass whose cutoff follows an envelope.
function saw(ph) { return 2 * (ph - Math.floor(ph + 0.5)); }
function pluck(t, midi, gain, pan, cutoff = 2400, decay = 0.22, send = 0.3) {
    const s = Math.floor(t * SR), n = Math.floor(decay * 5 * SR), f = mtof(midi);
    let ph = 0, lp = 0;
    for (let i = 0; i < n; i++) {
        const x = i / SR;
        ph += f / SR;
        const c = 200 + cutoff * Math.exp(-x / 0.08);
        const a = 1 - Math.exp(-2 * Math.PI * c / SR);
        lp += a * (saw(ph) + 0.5 * saw(ph * 1.003) - lp);
        const v = lp * Math.exp(-x / decay) * gain;
        add(s + i, v * (1 - pan), v * (1 + pan), send);
    }
}
function bassNote(t, midi, dur, gain, cutoff) {
    const s = Math.floor(t * SR), n = Math.floor(dur * SR), f = mtof(midi);
    let ph = 0, lp = 0, lp2 = 0;
    for (let i = 0; i < n; i++) {
        const x = i / SR;
        ph += f / SR;
        const a = 1 - Math.exp(-2 * Math.PI * (cutoff * (0.35 + 0.65 * Math.exp(-x / 0.12))) / SR);
        lp += a * (saw(ph) - lp); lp2 += a * (lp - lp2);
        const env = Math.min(1, x / 0.004) * Math.min(1, (dur - x) / 0.02);
        const sub = Math.sin(2 * Math.PI * f / 2 * x) * 0.6;
        const v = (lp2 * 0.7 + sub) * env * gain;
        add(s + i, v, v);
    }
}
function padChord(t, notes, dur, gain, bright) {
    const s = Math.floor(t * SR), n = Math.floor((dur + 1.2) * SR);
    for (const [k, midi] of notes.entries()) {
        const f = mtof(midi);
        for (const [d, pan] of [[-0.11, -0.6], [0.0, 0], [0.12, 0.6]]) {
            const ff = f * Math.pow(2, d / 12);
            let ph = rand() * 0.5 + 0.5, lp = 0;
            for (let i = 0; i < n; i++) {
                const x = i / SR;
                ph += ff / SR;
                const a = 1 - Math.exp(-2 * Math.PI * (500 + bright * 1400) / SR);
                lp += a * (saw(ph) - lp);
                const env = Math.min(1, x / 0.6) * (x > dur ? Math.exp(-(x - dur) / 0.4) : 1);
                const v = lp * env * gain / notes.length * (k === 0 ? 1.2 : 1);
                add(s + i, v * (1 - pan * 0.5), v * (1 + pan * 0.5), 0.45);
            }
        }
    }
}
function riser(t0, t1, gain) {
    const s = Math.floor(t0 * SR), n = Math.floor((t1 - t0) * SR);
    let lp = 0, ph = 0;
    for (let i = 0; i < n; i++) {
        const p = i / n;
        const w = rand();
        const a = 1 - Math.exp(-2 * Math.PI * (300 + 9000 * p * p) / SR);
        lp += a * (w - lp);
        ph += (220 + 1600 * p * p) / SR;
        const v = (lp * 0.8 + Math.sin(2 * Math.PI * ph) * 0.25) * p * p * gain;
        add(s + i, v * (1 - 0.4 * Math.sin(p * 20)), v * (1 + 0.4 * Math.sin(p * 20)), 0.3);
    }
}
function impact(t, gain = 1) {
    const s = Math.floor(t * SR), n = Math.floor(2.4 * SR);
    let ph = 0, lp = 0;
    for (let i = 0; i < n; i++) {
        const x = i / SR;
        ph += (32 + 60 * Math.exp(-x / 0.25)) / SR;
        const w = rand(); lp += 0.08 * (w - lp);
        const v = (Math.sin(2 * Math.PI * ph) * Math.exp(-x / 0.9) * 0.9 + lp * 3 * Math.exp(-x / 0.35)) * gain;
        add(s + i, v, v, 0.35);
    }
}
function snareRoll(t0, t1) {
    const steps = 16;
    for (let k = 0; k < steps; k++) {
        const p = k / steps;
        const div = p < 0.5 ? 8 : 16;
        const tt = t0 + (t1 - t0) * (Math.floor(p * div) / div);
        if (k === 0 || Math.floor(p * div) !== Math.floor(((k - 1) / steps) * div)) clap(tt, 0.12 + 0.2 * p);
    }
}

// --- arrangement ---------------------------------------------------------
for (let bar = 0; bar < BARS; bar++) {
    const t = bar * BAR, ch = chordAt(bar);
    const accel = bar >= S.accel && bar < S.end;
    // Pads everywhere, brightening through the piece; the end card holds Am.
    if (bar < S.end) padChord(t, [ch[0] - 12, ...ch], BAR, bar < S.beat ? 0.05 : 0.07, Math.min(1, bar / 12));
    // Intro plucks, sparse.
    if (bar < S.beat) for (const b of [0, 1.5, 2.5, 3]) pluck(t + b * BEAT, ch[(b * 2) % 3] + 12, 0.12, 0.3 * Math.sin(b), 1800, 0.4, 0.5);
    if (bar >= S.beat && bar < S.end) {
        for (let b = 0; b < 4; b++) {
            kick(t + b * BEAT);
            hat(t + (b + 0.5) * BEAT, 0.16, 0.04);
            if (bar >= S.full) { hat(t + (b + 0.25) * BEAT, 0.06, 0.02, -0.4); hat(t + (b + 0.75) * BEAT, 0.07, 0.02, -0.4); }
            // Off-beat bass, octave jumps in the full section.
            const cutoff = 400 + (accel ? 1600 * ((bar - S.accel) / 3) : bar >= S.full ? 900 : 500);
            bassNote(t + (b + 0.5) * BEAT, ch[0] - 24 + (bar >= S.full && b % 2 ? 12 : 0), BEAT * 0.45, 0.32, cutoff);
        }
        if (bar >= S.arp) { clap(t + BEAT); clap(t + 3 * BEAT); }
    }
    // Arpeggio: 16ths up the chord, ping-ponged.
    if (bar >= S.arp && bar < S.end) {
        const pat = [0, 1, 2, 3, 2, 1, 2, 3, 0, 1, 2, 3, 2, 3, 1, 2];
        for (let k = 0; k < 16; k++) {
            const note = [ch[0], ch[1], ch[2], ch[0] + 12][pat[k]] + 12;
            const cut = accel ? 1800 + 2400 * ((bar - S.accel) / 3) : 1600;
            pluck(t + k * BEAT / 4, note, bar >= S.full ? 0.075 : 0.06, k % 2 ? 0.55 : -0.55, cut, 0.13, 0.35);
        }
    }
}
// Transitions.
riser(1 * BAR, S.beat * BAR, 0.35);
impact(S.beat * BAR, 0.8);
impact(S.full * BAR, 0.7);
riser((S.full - 1) * BAR, S.full * BAR, 0.3);
riser((S.end - 2) * BAR, S.end * BAR, 0.45);
snareRoll((S.end - 1) * BAR, S.end * BAR);
// End card: the final hit and a held Am.
impact(S.end * BAR, 1.1);
kick(S.end * BAR, 1.1);
padChord(S.end * BAR, [45, 57, 60, 64, 69], 2 * BAR - 0.3, 0.1, 0.55);
pluck(S.end * BAR, 81, 0.16, 0, 3000, 0.9, 0.7);
pluck(S.end * BAR + BEAT * 1.5, 76, 0.1, -0.5, 2400, 0.9, 0.7);
pluck(S.end * BAR + BEAT * 3, 72, 0.08, 0.5, 2000, 1.2, 0.7);

// Sidechain: duck everything but the kick-free end tail around each kick.
const duck = new Float32Array(LEN).fill(1);
for (let bar = S.beat; bar < S.end; bar++) for (let b = 0; b < 4; b++) {
    const s = Math.floor((bar * BAR + b * BEAT) * SR);
    for (let i = 0; i < BEAT * SR && s + i < LEN; i++) duck[s + i] = Math.min(duck[s + i], 0.45 + 0.55 * Math.min(1, i / (0.18 * SR)));
}

// Reverb: a small Schroeder network (parallel combs into series all-passes).
function reverb(inp) {
    const out = new Float32Array(LEN);
    for (const [d, g] of [[1557, .82], [1617, .81], [1491, .83], [1422, .82], [1277, .84], [1356, .83]]) {
        const buf = new Float32Array(d); let j = 0, lp = 0;
        for (let i = 0; i < LEN; i++) { const y = buf[j]; lp += 0.3 * (y - lp); buf[j] = inp[i] + lp * g; out[i] += y / 6; j = (j + 1) % d; }
    }
    for (const d of [225, 556, 441]) {
        const buf = new Float32Array(d); let j = 0;
        for (let i = 0; i < LEN; i++) { const x = out[i], y = buf[j]; buf[j] = x + y * 0.5; out[i] = y - x * 0.5; j = (j + 1) % d; }
    }
    return out;
}
const wetL = reverb(revL), wetR = reverb(revR);

// Kick bus is un-ducked: re-synthesize it separately would be costlier, so the
// duck curve is applied to the whole mix except its first 12 ms after a beat.
const out = new Int16Array(LEN * 2);
let peak = 0;
const mix = new Float32Array(LEN * 2);
for (let i = 0; i < LEN; i++) {
    const d = duck[i];
    const l = L[i] * (0.35 + 0.65 * d) + wetL[i] * 0.9;
    const r = R[i] * (0.35 + 0.65 * d) + wetR[i] * 0.9;
    mix[2 * i] = Math.tanh(l * 1.2); mix[2 * i + 1] = Math.tanh(r * 1.2);
    peak = Math.max(peak, Math.abs(mix[2 * i]), Math.abs(mix[2 * i + 1]));
}
const norm = 0.89 / peak; // about -1 dBFS
const total = Math.floor(30.05 * SR);
for (let i = 0; i < total; i++) {
    const fade = i > total - 0.4 * SR ? (total - i) / (0.4 * SR) : 1;
    out[2 * i] = Math.round(mix[2 * i] * norm * fade * 32767);
    out[2 * i + 1] = Math.round(mix[2 * i + 1] * norm * fade * 32767);
}
const data = Buffer.from(out.buffer, 0, total * 4);
const hdr = Buffer.alloc(44);
hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + data.length, 4); hdr.write('WAVE', 8);
hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(2, 22);
hdr.writeUInt32LE(SR, 24); hdr.writeUInt32LE(SR * 4, 28); hdr.writeUInt16LE(4, 32); hdr.writeUInt16LE(16, 34);
hdr.write('data', 36); hdr.writeUInt32LE(data.length, 40);
writeFileSync(new URL('./soundtrack.wav', import.meta.url), Buffer.concat([hdr, data]));
console.log(`soundtrack.wav: ${(total / SR).toFixed(2)} s, peak normalised from ${peak.toFixed(3)}`);

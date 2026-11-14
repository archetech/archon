// Every sample of the soundtrack is computed here: no recordings, no samples.
// 70 s, 96 bpm, D minor, 48 kHz stereo. A slow pad and a soft pulse carry it, and the
// sounds on top are placed at the picture's own times: a sweep for each marker that
// crosses between a wallet and a service, a bell for each highlighted line, and a
// low note when a step begins.
import { writeFileSync } from 'node:fs';

const SR = 48000, DURATION = 70, BEAT = 60 / 96;
const LEN = (DURATION + 2) * SR; // room for the tails
const L = new Float32Array(LEN), R = new Float32Array(LEN);
const revL = new Float32Array(LEN), revR = new Float32Array(LEN); // reverb send

let seed = 7;
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
const add = (i, l, r, send = 0) => { if (i >= 0 && i < LEN) { L[i] += l; R[i] += r; revL[i] += l * send; revR[i] += r * send; } };
const saw = ph => 2 * (ph - Math.floor(ph + 0.5));

// --- the picture's times, from page.html ---------------------------------
const STAGE = 3.7, RECAP = 58, END = 65;
// [start, chord (MIDI), root] for each scene; steps 1 to 5 begin at 15.2.
const SCENES = [
    [0.0, [62, 65, 69, 72], 38],   // title              Dm7
    [3.9, [62, 65, 69, 72], 38],   // two DIDs           Dm7
    [9.8, [58, 62, 65, 69], 34],   // paste              Bbmaj7
    [15.2, [60, 65, 69, 72], 41],  // 1 resolve          F
    [24.2, [60, 64, 67, 72], 36],  // 2 lock             C
    [33.2, [62, 65, 69, 74], 38],  // 3 send             Dm
    [42.2, [58, 62, 65, 70], 34],  // 4 collect          Bb
    [50.2, [60, 65, 69, 72], 41],  // 5 claim            F
    [RECAP, [58, 62, 65, 69], 34], // recap              Bbmaj7
    [END, [62, 65, 69, 74], 38],   // end card           Dm, with the ninth on top
];
const STEPS = [15.2, 24.2, 33.2, 42.2, 50.2];
// [time, from, to] in pan positions: -1 Alice's wallet, 0 a service, 1 Bob's wallet.
const MARKERS = [[15.4, -1, 0], [17.0, 0, -1], [24.5, -1, 0], [26.2, 0, -1], [33.5, -1, 0], [42.4, 1, 0], [44.0, 0, 1], [50.5, 1, 0], [52.2, 0, 1]];
const HIGHLIGHTS = [10.8, 12.2, 13.4, 18.6, 20.2, 21.8, 27.6, 29.2, 30.6, 36.4, 45.6];
const CLAIMED = 53.6;
const sceneAt = t => SCENES.findLast(scene => scene[0] <= t) ?? SCENES[0];

// --- instruments ---------------------------------------------------------
// A chord of detuned saws behind a low-pass, fading in and out slowly so that one
// scene's chord overlaps the next.
function pad(t, notes, dur, gain, cutoff) {
    const s = Math.floor(t * SR), n = Math.floor((dur + 2.5) * SR);
    for (const midi of notes) {
        for (const [detune, pan] of [[-0.09, -0.7], [0.0, 0], [0.1, 0.7]]) {
            const f = mtof(midi + detune);
            let ph = rand() * 0.5 + 0.5, lp = 0, lp2 = 0;
            for (let i = 0; i < n; i++) {
                const x = i / SR;
                ph += f / SR;
                const a = 1 - Math.exp(-2 * Math.PI * (cutoff * (0.8 + 0.2 * Math.sin(x * 0.7 + pan))) / SR);
                lp += a * (saw(ph) - lp); lp2 += a * (lp - lp2);
                const env = Math.min(1, x / 1.6) * (x > dur ? Math.exp(-(x - dur) / 0.9) : 1);
                const v = lp2 * env * gain / notes.length;
                add(s + i, v * (1 - pan * 0.5), v * (1 + pan * 0.5), 0.5);
            }
        }
    }
}
// A sine with a quieter octave above it: a soft mallet.
function mallet(t, midi, gain, pan, decay = 0.28, send = 0.4) {
    const s = Math.floor(t * SR), n = Math.floor(decay * 6 * SR), f = mtof(midi);
    for (let i = 0; i < n; i++) {
        const x = i / SR;
        const env = Math.min(1, x / 0.003) * Math.exp(-x / decay);
        const v = (Math.sin(2 * Math.PI * f * x) + 0.3 * Math.sin(2 * Math.PI * 2 * f * x) * Math.exp(-x / (decay * 0.4))) * env * gain;
        add(s + i, v * (1 - pan), v * (1 + pan), send);
    }
}
// Inharmonic partials: a small bell.
function bell(t, midi, gain, pan, decay = 0.9) {
    const s = Math.floor(t * SR), n = Math.floor(decay * 5 * SR), f = mtof(midi);
    for (let i = 0; i < n; i++) {
        const x = i / SR;
        let v = 0;
        for (const [ratio, level, fall] of [[1, 1, 1], [2.76, 0.45, 0.55], [5.4, 0.22, 0.3], [8.93, 0.1, 0.18]]) {
            v += Math.sin(2 * Math.PI * f * ratio * x) * level * Math.exp(-x / (decay * fall));
        }
        v *= Math.min(1, x / 0.002) * gain;
        add(s + i, v * (1 - pan), v * (1 + pan), 0.6);
    }
}
function sub(t, midi, dur, gain) {
    const s = Math.floor(t * SR), n = Math.floor((dur + 0.6) * SR), f = mtof(midi);
    for (let i = 0; i < n; i++) {
        const x = i / SR;
        const env = Math.min(1, x / 0.25) * (x > dur ? Math.exp(-(x - dur) / 0.2) : 1);
        const v = (Math.sin(2 * Math.PI * f * x) + 0.25 * Math.sin(2 * Math.PI * 2 * f * x)) * env * gain;
        add(s + i, v, v);
    }
}
function kick(t, gain) {
    const s = Math.floor(t * SR), n = Math.floor(0.4 * SR);
    let ph = 0;
    for (let i = 0; i < n; i++) {
        const x = i / SR;
        ph += 2 * Math.PI * (44 + 70 * Math.exp(-x / 0.03)) / SR;
        const v = Math.sin(ph) * Math.exp(-x / 0.14) * gain;
        add(s + i, v, v);
    }
}
function tick(t, gain, pan) {
    const s = Math.floor(t * SR), n = Math.floor(0.08 * SR);
    let lp = 0;
    for (let i = 0; i < n; i++) {
        const w = rand(); lp += 0.4 * (w - lp);
        const v = (w - lp) * Math.exp(-i / SR / 0.012) * gain;
        add(s + i, v * (1 - pan), v * (1 + pan), 0.15);
    }
}
// Filtered noise that rises, crosses from one side to the other and falls away: a
// marker travelling along a wire. 1.25 s, as long as the marker takes.
function sweep(t, from, to, gain) {
    const s = Math.floor(t * SR), n = Math.floor(1.25 * SR);
    let lp = 0, bp = 0;
    for (let i = 0; i < n; i++) {
        const p = i / n;
        const w = rand();
        const a = 1 - Math.exp(-2 * Math.PI * (500 + 3800 * Math.sin(Math.PI * p)) / SR);
        lp += a * (w - lp); bp += 0.06 * (lp - bp);
        const pan = (from + (to - from) * p) * 0.8;
        const v = (lp - bp) * Math.sin(Math.PI * p) ** 2 * gain;
        add(s + i, v * (1 - pan), v * (1 + pan), 0.3);
    }
}

// --- arrangement ---------------------------------------------------------
// Pads: one chord per scene, brighter through the five steps.
for (const [k, [start, chord]] of SCENES.entries()) {
    const end = SCENES[k + 1]?.[0] ?? DURATION;
    const step = STEPS.filter(time => time <= start).length;
    const lows = [chord[0] - 12, chord[1] - 12, chord[2] - 12];
    pad(start, [...lows, chord[2], chord[3]], end - start - 0.4, step ? 0.26 : 0.34, 420 + 160 * step);
}
// The title and the end card each open on a bell.
bell(0.3, 74, 0.1, 0, 1.6);
bell(END, 81, 0.11, 0, 2.2);
bell(END + BEAT * 2, 77, 0.07, -0.4, 2.0);
bell(END + BEAT * 4, 74, 0.06, 0.4, 2.4);

// The pulse: quarter notes while the two wallets are introduced, eighths through the
// steps, quarters again for the recap. It takes its notes from whichever scene it
// lands in, so the harmony changes on the pulse after a cut.
for (let k = 0, t = STAGE; t < END - 0.2; k++, t = STAGE + k * BEAT / 2) {
    const [, chord] = sceneAt(t);
    const stepped = t >= STEPS[0] && t < RECAP;
    if (!stepped && k % 2) continue;
    const note = chord[[0, 2, 1, 3, 2, 3, 1, 2][k % 8]] + (k % 16 === 7 ? 12 : 0);
    mallet(t, note + 12, stepped ? 0.075 : 0.06, k % 2 ? 0.45 : -0.45, stepped ? 0.2 : 0.32);
}
// Bass and a quiet kick under the five steps.
for (const [k, start] of STEPS.entries()) {
    const end = STEPS[k + 1] ?? RECAP;
    sub(start, sceneAt(start)[2], end - start - 0.3, 0.12);
}
sub(RECAP, 34, END - RECAP - 0.3, 0.1);
sub(END, 38, DURATION - END - 1.2, 0.12);
for (let k = 0, t = STEPS[0]; t < RECAP - 0.3; k++, t = STEPS[0] + k * BEAT) {
    if (k % 2 === 0) kick(t, t >= STEPS[2] ? 0.24 : 0.18);
    if (t >= STEPS[1]) tick(t + BEAT / 2, 0.035, k % 2 ? 0.5 : -0.5);
}

// Sound for the picture.
for (const start of STEPS) {
    mallet(start, sceneAt(start)[2] + 12, 0.2, 0, 0.9, 0.5);
    bell(start, sceneAt(start)[1][3] + 12, 0.045, 0, 1.4);
}
for (const [time, from, to] of MARKERS) sweep(time, from, to, 0.5);
for (const [k, time] of HIGHLIGHTS.entries()) {
    const chord = sceneAt(time)[1];
    bell(time, chord[k % 3 + 1] + 12, 0.05, k % 2 ? 0.3 : -0.3, 0.7);
}
// Claimed: the only rising figure in the piece.
for (const [k, midi] of [77, 81, 84].entries()) bell(CLAIMED + k * 0.11, midi, 0.085, (k - 1) * 0.35, 1.5);

// --- mix -----------------------------------------------------------------
// Reverb: a small Schroeder network (parallel combs into series all-passes).
function reverb(inp) {
    const out = new Float32Array(LEN);
    for (const [d, g] of [[1557, .86], [1617, .85], [1491, .87], [1422, .86], [1277, .88], [1356, .87]]) {
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

const total = DURATION * SR;
const mix = new Float32Array(total * 2);
let peak = 0;
for (let i = 0; i < total; i++) {
    mix[2 * i] = Math.tanh(L[i] + wetL[i] * 0.9);
    mix[2 * i + 1] = Math.tanh(R[i] + wetR[i] * 0.9);
    peak = Math.max(peak, Math.abs(mix[2 * i]), Math.abs(mix[2 * i + 1]));
}
const norm = 0.7 / peak; // about -3 dBFS: it sits under a video, it does not lead it
const out = new Int16Array(total * 2);
for (let i = 0; i < total; i++) {
    const fade = Math.min(1, i / (0.05 * SR), (total - i) / (2.2 * SR));
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

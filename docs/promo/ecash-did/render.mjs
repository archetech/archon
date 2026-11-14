// usage: CHROME=<headless chrome> node render.mjs stills <t1> <t2> ...   → still-<t>.png
//        CHROME=<headless chrome> node render.mjs video                  → ecash-did.mp4 (30 fps + soundtrack.wav)
//
// page.html positions every animation from window.seek(t), so a frame depends only on
// its time and the video is the same on every run.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const [mode, ...args] = process.argv.slice(2);
const FPS = 30;
if (!process.env.CHROME) throw new Error('set CHROME to a Chrome or chrome-headless-shell binary');
if (mode !== 'video' && mode !== 'stills') throw new Error('usage: node render.mjs video | stills <t> ...');
const soundtrack = path.join(dir, 'soundtrack.wav');
if (mode === 'video' && !existsSync(soundtrack)) throw new Error('soundtrack.wav is missing; run node audio.mjs first');

const browser = await chromium.launch({ executablePath: process.env.CHROME });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.on('pageerror', error => { throw error; });
await page.addInitScript(`window.DATA = ${readFileSync(path.join(dir, 'data.json'), 'utf8')};`);
await page.goto('file://' + path.join(dir, 'page.html'));
await page.evaluate(() => Promise.all([document.fonts.ready, ...[...document.images].map(image => image.decode())]));
const frame = async (t, type) => {
    await page.evaluate(seconds => window.seek(seconds), t);
    return page.screenshot({ type });
};

if (mode === 'stills') {
    for (const t of args) {
        await page.evaluate(seconds => window.seek(seconds), Number(t));
        await page.screenshot({ path: path.join(dir, `still-${t}.png`) });
        console.log('still', t);
    }
} else {
    const ffmpeg = spawn('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', '-',
        '-i', soundtrack, '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-profile:v', 'high',
        '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', '-shortest',
        path.join(dir, 'ecash-did.mp4')], { stdio: ['pipe', 'inherit', 'inherit'] });
    const done = new Promise((resolve, reject) => {
        ffmpeg.on('error', error => reject(new Error(`could not start ffmpeg: ${error.message}`)));
        ffmpeg.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}`)));
    });
    ffmpeg.stdin.on('error', () => { /* ffmpeg exited early; its exit code is reported by `done` */ });
    done.catch(() => {});
    const total = FPS * await page.evaluate(() => window.DURATION);
    for (let i = 0; i < total && ffmpeg.exitCode === null; i++) {
        const png = await frame(i / FPS, 'png');
        if (!ffmpeg.stdin.write(png)) await Promise.race([new Promise(resolve => ffmpeg.stdin.once('drain', resolve)), done]);
        if (i % 300 === 0) console.log(`frame ${i}/${total}`);
    }
    ffmpeg.stdin.end();
    await done;
    console.log('wrote ecash-did.mp4');
}
await browser.close();

// usage: CHROME=<headless chrome> node render.mjs stills <t1> <t2> ...   → still-<t>.png
//        CHROME=<headless chrome> node render.mjs video                  → archon-promo.mp4 (60 fps + soundtrack.wav)
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const [mode, ...args] = process.argv.slice(2);
const PORT = 9480, FPS = 60, DURATION = 30;
if (!process.env.CHROME) throw new Error('set CHROME to a Chrome or chrome-headless-shell binary');
const chrome = spawn(process.env.CHROME, ['--headless', '--no-sandbox', '--hide-scrollbars', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${dir}/chrome-profile`, '--window-size=1920,1080', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws;
for (let i = 0; i < 60 && !ws; i++) { try { const page = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find(t => t.type === 'page'); if (page) ws = new WebSocket(page.webSocketDebuggerUrl); } catch { await sleep(200); } }
await new Promise(r => ws.addEventListener('open', r));
let id = 0; const pending = new Map();
ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } if (m.method === 'Runtime.exceptionThrown') console.error('PAGE EXCEPTION', m.params.exceptionDetails.exception?.description); });
const send = (method, params = {}) => new Promise(r => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: 'file://' + path.join(dir, 'page.html') });
const ready = await send('Runtime.evaluate', { expression: 'new Promise(r => { const w = () => window.ready ? window.ready.then(r) : setTimeout(w, 50); w(); })', awaitPromise: true, returnByValue: true });
if (!ready.result?.result?.value) throw new Error('fonts did not load');
const clip = { x: 0, y: 0, width: 1920, height: 1080, scale: 1 };
async function frame(t, format) {
    await send('Runtime.evaluate', { expression: `render(${t})` });
    const shot = await send('Page.captureScreenshot', { format, quality: format === 'jpeg' ? 94 : undefined, clip, optimizeForSpeed: true });
    return Buffer.from(shot.result.data, 'base64');
}

if (mode === 'stills') {
    for (const t of args) { writeFileSync(path.join(dir, `still-${t}.png`), await frame(Number(t), 'png')); console.log('still', t); }
} else {
    const ff = spawn('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
        '-i', path.join(dir, 'soundtrack.wav'), '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-profile:v', 'high',
        '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', '-shortest', path.join(dir, 'archon-promo.mp4')], { stdio: ['pipe', 'inherit', 'inherit'] });
    const total = FPS * DURATION, started = Date.now();
    for (let i = 0; i < total; i++) {
        const buf = await frame(i / FPS, 'jpeg');
        if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
        if (i % 300 === 0) console.log(`frame ${i}/${total} (${((Date.now() - started) / 1000).toFixed(0)} s)`);
    }
    ff.stdin.end();
    await new Promise(r => ff.on('close', r));
    console.log('wrote archon-promo.mp4');
}
ws.close(); chrome.kill();

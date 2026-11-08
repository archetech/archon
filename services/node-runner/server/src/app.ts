import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'fs';
import { join } from 'path';
import { Auth, AuthError, MIN_PASSWORD_LENGTH, SESSION_TTL_MS } from './auth.js';
import { DockerError, type DockerApi } from './docker.js';
import { collectLogs, containerSignature, followLogs, parseTail, resolveTargets, timeKey } from './logs.js';
import { statusReport } from './status.js';

export const SESSION_COOKIE = 'node_runner_session';
export const SESSION_RECHECK_MS = 10000;

export interface AppDependencies {
    auth: Auth;
    docker: DockerApi;
    project: string;
    gitCommit: string;
    clientDir?: string | null;
    // How often a live log stream checks whether its containers changed.
    watchIntervalMs?: number;
}

export function readCookie(header: string | undefined, name: string): string | undefined {
    for (const part of (header ?? '').split(';')) {
        const [key, ...rest] = part.trim().split('=');
        if (key === name) {
            return decodeURIComponent(rest.join('='));
        }
    }
    return undefined;
}

// HttpOnly and SameSite=Strict: scripts cannot read the session, and other
// sites cannot send it. Secure is set when the request arrived over HTTPS,
// directly or through a reverse proxy.
function setSessionCookie(req: Request, res: Response, token: string): void {
    const secure = req.secure || req.get('x-forwarded-proto') === 'https';
    res.setHeader('Set-Cookie', [
        `${SESSION_COOKIE}=${token}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Strict',
        `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
        ...(secure ? ['Secure'] : []),
    ].join('; '));
}

function clearSessionCookie(res: Response): void {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

function sendError(res: Response, error: unknown): void {
    if (error instanceof AuthError || error instanceof DockerError) {
        res.status(error.status).json({ error: error.message });
        return;
    }
    console.error(error);
    res.status(500).json({ error: 'Internal error' });
}

function serviceList(value: unknown): string[] {
    return typeof value === 'string' && value ? value.split(',').map(s => s.trim()).filter(Boolean) : [];
}

function sinceSeconds(value: unknown): number | undefined {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function createApp(deps: AppDependencies): express.Express {
    const { auth, docker, project } = deps;
    const app = express();

    app.disable('x-powered-by');
    app.use((_req, res, next) => {
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
        next();
    });
    app.use(express.json({ limit: '16kb' }));

    const api = express.Router();

    api.get('/session', async (req, res) => {
        try {
            const configured = await auth.isConfigured();
            if (!configured) {
                await auth.ensureSetupCode();
            }
            const token = readCookie(req.headers.cookie, SESSION_COOKIE);
            res.json({
                configured,
                authenticated: configured && auth.checkSession(token),
                minPasswordLength: MIN_PASSWORD_LENGTH,
            });
        }
        catch (error) {
            sendError(res, error);
        }
    });

    api.post('/setup', async (req, res) => {
        try {
            const token = await auth.setup(String(req.body?.code ?? ''), req.body?.password);
            setSessionCookie(req, res, token);
            res.json({ ok: true });
        }
        catch (error) {
            sendError(res, error);
        }
    });

    api.post('/login', async (req, res) => {
        try {
            const token = await auth.login(req.body?.password);
            setSessionCookie(req, res, token);
            res.json({ ok: true });
        }
        catch (error) {
            sendError(res, error);
        }
    });

    api.post('/logout', (req, res) => {
        auth.logout(readCookie(req.headers.cookie, SESSION_COOKIE));
        clearSessionCookie(res);
        res.json({ ok: true });
    });

    // Everything below needs a session. A deleted password hash ends every
    // session at once, so the check reads it each time.
    api.use(async (req: Request, res: Response, next: NextFunction) => {
        try {
            if (!(await auth.isConfigured())) {
                await auth.ensureSetupCode();
                res.status(401).json({ error: 'node-runner is not set up yet' });
                return;
            }
            const token = readCookie(req.headers.cookie, SESSION_COOKIE);
            if (!auth.checkSession(token)) {
                res.status(401).json({ error: 'Not signed in' });
                return;
            }
            // The session slides on the server, so the cookie slides with it.
            setSessionCookie(req, res, token!);
            next();
        }
        catch (error) {
            sendError(res, error);
        }
    });

    api.get('/info', (_req, res) => {
        res.json({ project, gitCommit: deps.gitCommit });
    });

    api.get('/status', async (_req, res) => {
        try {
            res.json(await statusReport(docker, project));
        }
        catch (error) {
            sendError(res, error);
        }
    });

    // One-off logs: JSON for the UI, or plain text to download.
    api.get('/logs', async (req, res) => {
        try {
            const targets = await resolveTargets(docker, project, serviceList(req.query.services));
            const entries = await collectLogs(docker, targets, {
                tail: parseTail(req.query.tail, 200),
                since: sinceSeconds(req.query.since),
            });
            if (req.query.format === 'text') {
                res.setHeader('Content-Type', 'text/plain; charset=utf-8');
                res.setHeader('Content-Disposition', `attachment; filename="${project}-logs.txt"`);
                res.send(entries.map(e => `${e.time} ${e.service} ${e.text}`).join('\n') + '\n');
                return;
            }
            res.json({ entries });
        }
        catch (error) {
            sendError(res, error);
        }
    });

    // Live logs as server-sent events, one `log` event per line.
    api.get('/logs/stream', async (req, res) => {
        const controller = new AbortController();
        req.on('close', () => controller.abort());
        // Access is checked once at the start; the stream ends as soon as the
        // session does, through logout, expiry or a password reset.
        const token = readCookie(req.headers.cookie, SESSION_COOKIE);
        const stopRevoke = auth.onRevoke(revoked => {
            if (revoked === null || revoked === token) {
                controller.abort();
            }
        });
        const recheck = setInterval(async () => {
            if (!auth.peekSession(token) || !(await auth.isConfigured())) {
                controller.abort();
            }
        }, SESSION_RECHECK_MS);
        controller.signal.addEventListener('abort', () => {
            stopRevoke();
            clearInterval(recheck);
        }, { once: true });
        try {
            const targets = await resolveTargets(docker, project, serviceList(req.query.services));
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache, no-transform',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no',
            });
            res.write(': connected\n\n');
            const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);
            controller.signal.addEventListener('abort', () => clearInterval(heartbeat), { once: true });
            const services = serviceList(req.query.services);
            await followLogs(docker, targets, { tail: parseTail(req.query.tail, 200), since: sinceSeconds(req.query.since) }, entry => {
                res.write(`event: log\ndata: ${JSON.stringify({ ...entry, key: timeKey(entry.time) })}\n\n`);
            }, controller.signal, { signature: () => containerSignature(docker, project, services), intervalMs: deps.watchIntervalMs ?? 5000 });
            res.end();
        }
        catch (error) {
            if (!res.headersSent) {
                sendError(res, error);
            }
            else {
                // The stream is already open, so the failure travels as an event.
                const status = (error as { status?: unknown })?.status;
                const message = error instanceof Error && typeof status === 'number' ? error.message : 'Internal error';
                if (message === 'Internal error') {
                    console.error(error);
                }
                res.write(`event: failure\ndata: ${JSON.stringify({ error: message })}\n\n`);
                res.end();
            }
        }
        finally {
            // Releases the heartbeat, the revocation listener and the recheck.
            controller.abort();
        }
    });

    api.use((_req, res) => {
        res.status(404).json({ error: 'Not found' });
    });

    app.use('/api', api);

    if (deps.clientDir && existsSync(deps.clientDir)) {
        const clientDir = deps.clientDir;
        app.use(express.static(clientDir, { index: false }));
        app.get(/.*/, (_req, res) => {
            res.sendFile(join(clientDir, 'index.html'));
        });
    }

    return app;
}

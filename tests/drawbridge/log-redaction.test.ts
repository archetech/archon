import express from 'express';
import pino from 'pino';
import pinoHttp from 'pino-http';
import request from 'supertest';
import { Writable } from 'stream';

import { REDACTED_LOG_PATHS } from '../../services/drawbridge/server/src/log-redaction.ts';

// Drawbridge's production request log records headers; bearer secrets in them
// (Poppy Session Tokens and proofs, cookies, codes in redirects) are redacted.
describe('request log redaction', () => {
    it('logs secret-bearing headers as redacted and keeps the rest', async () => {
        const lines: string[] = [];
        const stream = new Writable({ write(chunk, _enc, done) { lines.push(chunk.toString()); done(); } });
        const app = express();
        app.use((pinoHttp as any)({ logger: pino(stream), redact: { paths: REDACTED_LOG_PATHS, censor: '[redacted]' } }));
        app.get('/names/poppy/authorize', (_req, res) => {
            res.cookie('poppy_sgn_1', 'browser-secret');
            res.redirect(303, 'https://agent.example/cb?code=pac_secret&iss=x');
        });

        await request(app).get('/names/poppy/authorize')
            .set('Authorization', 'DPoP pst_secret')
            .set('DPoP', 'eyJproof')
            .set('Cookie', 'connect.sid=s3cret')
            .set('X-Archon-Admin-Key', 'admin-secret')
            .set('User-Agent', 'test-agent');

        const log = lines.join('');
        for (const secret of ['pst_secret', 'eyJproof', 's3cret', 'admin-secret', 'browser-secret', 'pac_secret']) {
            expect(log).not.toContain(secret);
        }
        expect(log).toContain('[redacted]');
        expect(log).toContain('test-agent');
    });
});

import cors from 'cors';
import express from 'express';
import request from 'supertest';

import { DEFAULT_CORS_OPTIONS } from '../../services/drawbridge/server/src/cors-options.ts';

describe('default CORS', () => {
    it('lets a browser read the payment challenge headers of a 402', async () => {
        const app = express();
        app.use(cors(DEFAULT_CORS_OPTIONS));
        app.post('/api/v1/did', (_req, res) => {
            res.setHeader('WWW-Authenticate', 'L402 macaroon="m", invoice="lnbc1"');
            res.setHeader('X-Cashu', 'creqAtest');
            res.status(402).json({ error: 'Payment required' });
        });

        const res = await request(app).post('/api/v1/did').set('Origin', 'https://wallet.example');

        expect(res.status).toBe(402);
        const exposed = String(res.headers['access-control-expose-headers']).split(',').map(h => h.trim());
        expect(exposed).toEqual(expect.arrayContaining(['WWW-Authenticate', 'X-Cashu', 'X-L402-Price', 'X-L402-Operation']));
    });

    it('accepts X-Cashu on a preflighted retry', async () => {
        const app = express();
        app.use(cors(DEFAULT_CORS_OPTIONS));

        const res = await request(app).options('/api/v1/did')
            .set('Origin', 'https://wallet.example')
            .set('Access-Control-Request-Method', 'POST')
            .set('Access-Control-Request-Headers', 'x-cashu');

        expect(res.status).toBe(204);
        expect(String(res.headers['access-control-allow-headers'])).toContain('x-cashu');
    });
});

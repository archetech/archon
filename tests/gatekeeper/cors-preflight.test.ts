import { jest } from '@jest/globals';
import request from 'supertest';
import { createGatekeeperApp } from '../../services/gatekeeper/server/src/gatekeeper-api.ts';

// The app used to register `app.options('*', cors())` alongside `app.use(cors())`.
// That route was unreachable -- cors() ends the OPTIONS request itself rather
// than calling next() -- and Express 5 rejects a bare '*' path, so the server
// threw before it could listen (#1023). Removing it must not cost preflight.

function createApp() {
    const { app } = createGatekeeperApp({
        gatekeeper: {
            getStatus: jest.fn<any>().mockResolvedValue({}),
            listRegistries: jest.fn<any>().mockResolvedValue([]),
        } as any,
        httpLogging: false,
    });
    return app;
}

describe('CORS preflight', () => {
    it('answers OPTIONS without a wildcard route registered', async () => {
        const response = await request(createApp())
            .options('/api/v1/ready')
            .set('Origin', 'https://example.com')
            .set('Access-Control-Request-Method', 'GET');

        expect(response.status).toBe(204);
        expect(response.headers['access-control-allow-origin']).toBe('*');
        expect(response.headers['access-control-allow-methods']).toBeDefined();
    });

    it('still sets the origin header on a normal request', async () => {
        const response = await request(createApp())
            .get('/api/v1/ready')
            .set('Origin', 'https://example.com');

        expect(response.headers['access-control-allow-origin']).toBe('*');
    });
});

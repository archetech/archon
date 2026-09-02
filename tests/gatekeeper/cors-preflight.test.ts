import { jest } from '@jest/globals';
import request from 'supertest';
import { createGatekeeperApp } from '../../services/gatekeeper/server/src/gatekeeper-api.ts';

// cors() is mounted globally rather than behind a wildcard OPTIONS route: it
// answers preflight itself, ending the request instead of calling next(). These
// pin the browser-visible contract that arrangement has to satisfy.

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

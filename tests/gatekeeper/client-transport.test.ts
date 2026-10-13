import http from 'node:http';
import type { AddressInfo } from 'node:net';
import GatekeeperClient, {
    GatekeeperTimeoutError,
    GatekeeperUnavailableError,
} from '@didcid/clients/gatekeeper';
import DrawbridgeClient from '@didcid/clients/drawbridge';

// A Gatekeeper that stalls or is down used to surface as a bare string, which the
// Keymaster service could not tell from any other failure (#1380). These use real
// sockets: the failure modes are transport behaviour a mocked reply cannot show.

const DID = 'did:cid:bagaaieratransport';

async function listen(server: http.Server): Promise<string> {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('GatekeeperClient transport failures', () => {
    it('raises GatekeeperTimeoutError when Gatekeeper does not answer in time', async () => {
        const server = http.createServer(() => { /* never responds */ });
        const url = await listen(server);
        try {
            const gatekeeper = await GatekeeperClient.create({ url, timeoutMs: 100 });
            const failure = gatekeeper.resolveDID(DID);
            await expect(failure).rejects.toBeInstanceOf(GatekeeperTimeoutError);
            await expect(failure).rejects.toThrow('Gatekeeper did not respond');
        }
        finally {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        }
    });

    it('raises GatekeeperUnavailableError when Gatekeeper refuses the connection', async () => {
        const server = http.createServer();
        const url = await listen(server);
        await new Promise(resolve => server.close(resolve));

        const gatekeeper = await GatekeeperClient.create({ url });
        const failure = gatekeeper.resolveDID(DID);
        await expect(failure).rejects.toBeInstanceOf(GatekeeperUnavailableError);
        await expect(failure).rejects.toThrow('Gatekeeper unavailable');
    });

    // The Keymaster service talks to its Gatekeeper URL through a
    // DrawbridgeClient, whose Lightning routes need the same classification.
    it('classifies Drawbridge Lightning requests the same way', async () => {
        const stalled = http.createServer(() => { /* never responds */ });
        const url = await listen(stalled);
        try {
            const drawbridge = await DrawbridgeClient.create({ url, timeoutMs: 100 });
            await expect(drawbridge.createLightningWallet('wallet'))
                .rejects.toBeInstanceOf(GatekeeperTimeoutError);
        }
        finally {
            stalled.closeAllConnections();
            await new Promise(resolve => stalled.close(resolve));
        }

        const closed = http.createServer();
        const closedUrl = await listen(closed);
        await new Promise(resolve => closed.close(resolve));
        const drawbridge = await DrawbridgeClient.create({ url: closedUrl });
        await expect(drawbridge.getLightningBalance('invoice-key'))
            .rejects.toBeInstanceOf(GatekeeperUnavailableError);
    });

    it('still passes Gatekeeper error responses through unchanged', async () => {
        const server = http.createServer((_req, res) => {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'DID not found' }));
        });
        const url = await listen(server);
        try {
            const gatekeeper = await GatekeeperClient.create({ url, timeoutMs: 1000 });
            await expect(gatekeeper.resolveDID(DID)).rejects.toEqual({ error: 'DID not found' });
        }
        finally {
            await new Promise(resolve => server.close(resolve));
        }
    });
});

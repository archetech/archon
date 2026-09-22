import { SocksClient } from 'socks';

// A SOCKS CONNECT to the published onion proves that Tor can reach the hidden
// service and establish its forwarding socket. The hostname file alone does not.
export async function probeOnion(hostname: string, port: number, proxyAddress: string, timeout = 5000): Promise<void> {
    if (!/^[a-z2-7]{56}\.onion$/.test(hostname)) {
        throw new Error('invalid Tor v3 hostname');
    }
    if (!proxyAddress) {
        throw new Error('Tor SOCKS proxy is not configured');
    }
    const proxy = new URL(`socks5://${proxyAddress}`);
    if (!proxy.hostname || !Number.isInteger(Number(proxy.port)) || Number(proxy.port) < 1 || Number(proxy.port) > 65535) {
        throw new Error('invalid Tor SOCKS proxy address');
    }
    const { socket } = await SocksClient.createConnection({
        command: 'connect',
        proxy: { type: 5, host: proxy.hostname, port: Number(proxy.port) },
        destination: { host: hostname, port },
        timeout,
    });
    socket.destroy();
}

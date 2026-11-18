
import { create, KuboRPCClient } from 'kubo-rpc-client'
import { CID } from 'multiformats/cid';
import * as jsonCodec from 'multiformats/codecs/json';
import * as sha256 from 'multiformats/hashes/sha2';
import { isPrivateHostname } from '@didcid/common/net';
import { encodeJSON } from './utils.js';
import { IPFSClient, JSONEncodingOptions } from './types.js';

// The most addresses of one peer that are dialled. A node advertises a handful:
// one for each transport on each public address it has.
const MAX_PEER_ADDRESSES = 16;

const IPV4 = /^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/;
const IPV6 = /^[0-9a-fA-F:.]+$/;

// Whether a multiaddr begins with a public IP address written out in full. That
// is the only kind dialled or advertised: a name could resolve anywhere, and an
// address inside this host or its network is not a peer's to offer.
export function isPublicIpMultiaddr(address: unknown): address is string {
    if (typeof address !== 'string') {
        return false;
    }

    const match = /^\/ip([46])\/([^/]+)\//.exec(address);

    if (!match) {
        return false;
    }

    const [, version, host] = match;
    const literal = version === '4'
        ? IPV4.test(host) && host.split('.').every(part => Number(part) <= 255)
        : IPV6.test(host) && host.includes(':');

    return literal && !isPrivateHostname(host);
}

interface KuboClientConfig {
    url: string;
    waitUntilReady?: boolean;
    intervalSeconds?: number;
    chatty?: boolean;
    becomeChattyAfter?: number;
    maxRetries?: number;
}

interface PeeringPeer {
    ID: string;
    Addrs: string[];
}

class KuboClient implements IPFSClient {
    private ipfs: KuboRPCClient | any;

    // Factory method
    static async create(options: KuboClientConfig): Promise<KuboClient> {
        const ipfs = new KuboClient();
        await ipfs.connect(options);
        return ipfs;
    }

    async connect(options: KuboClientConfig): Promise<void> {
        this.ipfs = create(options);

        if (options.waitUntilReady) {
            await this.waitUntilReady(options);
        }
    }

    async waitUntilReady(options: KuboClientConfig): Promise<void> {
        let { intervalSeconds = 5, chatty = false, becomeChattyAfter = 0, maxRetries = 0 } = options;
        let ready = false;
        let retries = 0;

        if (chatty) {
            console.log(`Connecting to IPFS at ${options.url}`);
        }

        while (!ready) {
            ready = await this.isReady();

            if (!ready) {
                if (chatty) {
                    console.log('Waiting for IPFS to be ready...');
                }
                // wait for 1 second before checking again
                await new Promise(resolve => setTimeout(resolve, intervalSeconds * 1000));
            }

            retries += 1;

            if (maxRetries > 0 && retries > maxRetries) {
                return;
            }

            if (!chatty && becomeChattyAfter > 0 && retries > becomeChattyAfter) {
                console.log(`Connecting to IPFS at ${options.url}`);
                chatty = true;
            }
        }

        if (chatty) {
            console.log('IPFS service is ready!');
        }
    }

    async isReady(): Promise<boolean> {
        try {
            await this.ipfs.id();
            return true;
        }
        catch (error) {
            return false;
        }
    }

    async addText(text: string): Promise<string> {
        const { cid } = await this.ipfs.add(text, { cidVersion: 1 });
        return cid.toString(); // CID v1 default: base32 encoding
    }

    async getText(cid: string): Promise<string> {
        const chunks = [];
        for await (const chunk of this.ipfs.cat(cid, { timeout: 10000 })) {
            chunks.push(chunk);
        }
        const data = Buffer.concat(chunks);
        return data.toString();
    }

    async addData(data: Buffer): Promise<string> {
        const { cid } = await this.ipfs.add(data, { cidVersion: 1 });
        return cid.toString(); // CID v1 default: base32 encoding
    }

    async getData(cid: string): Promise<Buffer> {
        const chunks = [];
        for await (const chunk of this.ipfs.cat(cid, { timeout: 10000 })) {
            chunks.push(chunk);
        }
        return Buffer.concat(chunks);
    }

    async addDataStream(stream: AsyncIterable<Uint8Array>): Promise<string> {
        const { cid } = await this.ipfs.add(stream, { cidVersion: 1 });
        return cid.toString();
    }

    getDataStream(cid: string): AsyncIterable<Uint8Array> {
        return this.ipfs.cat(cid);
    }

    async addJSON(json: any, options?: JSONEncodingOptions): Promise<string> {
        // Encode the JSON data using jsonCodec
        const buf = encodeJSON(json, options);
        const hash = await sha256.sha256.digest(buf);
        const cid = CID.createV1(jsonCodec.code, hash);

        // !!! No need to await since we pre-generated the cid?
        await this.ipfs.block.put(buf, { cid });

        return cid.toString(); // CID v1 default: base32 encoding
    }

    async getJSON(cid: string): Promise<any> {
        // Retrieve the data using ipfs.block.get instead of ipfs.cat
        const block = await this.ipfs.block.get(cid, { timeout: 10000 });
        return jsonCodec.decode(block);
    }

    async getID(): Promise<any> {
        return this.ipfs.id();
    }

    async getPeerID(): Promise<string> {
        const id = await this.ipfs.id();
        return id.id.toString();
    }

    async getAddresses(): Promise<string[]> {
        const id = await this.ipfs.id();
        const publicAddresses = [];

        for (const addr of id.addresses) {
            if (isPublicIpMultiaddr(addr.toString())) {
                publicAddresses.push(addr);
            }
        }

        return publicAddresses;
    }

    async addPeer(peer: string): Promise<boolean> {
        try {
            if (!isPublicIpMultiaddr(peer)) {
                console.warn(`Skipping peer address that is not a public IP address: ${peer}`);
                return false;
            }

            // Attempt to connect to the peer
            const response = await this.ipfs.swarm.connect(peer);

            // Validate the response (assuming it's a list containing a single string)
            if (Array.isArray(response) && response.length === 1 && typeof response[0] === 'string') {
                const responseString = response[0];
                if (responseString.includes('success')) {
                    console.log(`Successfully connected to peer: ${peer}`);
                    return true;
                }

                console.warn(`Unexpected response from swarm.connect: ${responseString}`);
                return false;
            }

            console.warn(`Unexpected response from swarm.connect: ${response}`);
            return false;
        } catch (error) {
            console.error(`Failed to connect to peer ${peer}:`, error);
            return false;
        }
    }

    async addPeers(peers: string[]): Promise<any> {
        const addedPeers: string[] = [];

        for (const peer of peers) {
            const ok = await this.addPeer(peer);

            if (ok) {
                console.log(`Added peer ${peer}`);
                addedPeers.push(peer);
            }
        }

        return addedPeers;
    }

    async getPeers(): Promise<any> {
        return this.ipfs.swarm.peers();
    }

    // Peering.Peers is a list of permanent peers
    readonly PeeringPeers = 'Peering.Peers';

    // Resolves true when the peer was written to Peering.Peers, false when it is
    // this node or none of its addresses could be dialed.
    async addPeeringPeer(id: string, addresses: string[]): Promise<boolean> {
        const peerID = await this.getPeerID();

        if (peerID === id) {
            // Not valid to add self as a peering peer
            return false;
        }

        // The list comes from the other node's DID document, so it is whatever
        // that node chose to write. Only public IP addresses are dialled, and
        // only so many of them: anything else would have this node's IPFS
        // daemon connect to an address inside its own network on a peer's say.
        const offered = (Array.isArray(addresses) ? addresses : [])
            .filter(isPublicIpMultiaddr)
            .slice(0, MAX_PEER_ADDRESSES);

        // Filter addresses to only those we can connect to
        const validAddresses: string[] = [];
        for (const addr of offered) {
            try {
                await this.ipfs.swarm.connect(addr);
                validAddresses.push(addr);
            } catch {
                // Ignore errors, just skip invalid addresses
            }
        }

        if (validAddresses.length === 0) {
            return false;
        }

        const currentPeers: PeeringPeer[] = await this.getPeeringPeers();

        // Check if peer is already present
        const existing = currentPeers.find(p => p.ID === id);

        if (existing) {
            // Merge addresses without duplicates
            existing.Addrs = Array.from(new Set([...existing.Addrs, ...validAddresses]));
        } else {
            currentPeers.push({ ID: id, Addrs: validAddresses });
        }

        await this.ipfs.config.set(this.PeeringPeers, currentPeers, { json: true });
        return true;
    }

    async removePeeringPeer(id: string): Promise<void> {
        const currentPeers: PeeringPeer[] = await this.getPeeringPeers();
        const filtered = currentPeers.filter(p => p.ID !== id);

        await this.ipfs.config.set(this.PeeringPeers, filtered, { json: true });
    }

    async getPeeringPeers(): Promise<PeeringPeer[]> {
        return (await this.ipfs.config.get(this.PeeringPeers)) || [];
    }

    async resetPeeringPeers(): Promise<void> {
        // Reset Peering.Peers to an empty array
        await this.ipfs.config.set(this.PeeringPeers, [], { json: true });
    }
}

export default KuboClient

import { jest } from '@jest/globals';
import { OnionReachability } from '../../services/drawbridge/server/src/onion-reachability.ts';

const onion = `${'a'.repeat(56)}.onion`;

it('reports a stale hostname as down and recovers when Tor becomes reachable', async () => {
    const onState = jest.fn<(state: -1 | 0 | 1) => void>();
    const onTransition = jest.fn<any>();
    const probe = jest.fn<any>().mockRejectedValueOnce(new Error('Tor proxy unavailable'))
        .mockResolvedValue(undefined);
    const monitor = new OnionReachability({
        hostnameFile: '/unused', proxy: 'tor:9050', port: 4222,
        readHostname: async () => `${onion}\n`, probe, onState, onTransition,
    });

    expect(await monitor.verifiedHostname()).toBeNull();
    expect(onState).toHaveBeenLastCalledWith(0);
    expect(onTransition).toHaveBeenCalledWith(0, expect.any(Error));
    expect(probe).toHaveBeenCalledWith(onion, 4222, 'tor:9050');
    await monitor.verifiedHostname();
    expect(probe).toHaveBeenCalledTimes(1);

    await monitor.refresh();
    expect(await monitor.verifiedHostname()).toBe(onion);
    expect(onState).toHaveBeenLastCalledWith(1);
    expect(onTransition).toHaveBeenCalledWith(1, undefined);
});

it('treats a missing hostname file as no advertised onion', async () => {
    const onState = jest.fn<any>();
    const probe = jest.fn<any>();
    const monitor = new OnionReachability({
        hostnameFile: '/unused', proxy: 'tor:9050', port: 4222,
        readHostname: async () => { throw new Error('ENOENT'); }, probe,
        onState, onTransition: jest.fn<any>(),
    });
    expect(await monitor.verifiedHostname()).toBeNull();
    expect(onState).toHaveBeenLastCalledWith(-1);
    expect(probe).not.toHaveBeenCalled();
});

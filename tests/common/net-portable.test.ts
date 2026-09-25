import { jest } from '@jest/globals';
import { fetchPublicHttps, isPrivateHostname } from '../../packages/common/src/net.ts';

describe('portable public HTTPS guard', () => {
    test.each(['http://public.example', 'https://localhost', 'https://127.1', 'https://0x7f000001',
        'https://0177.0.0.1', 'https://[::ffff:127.0.0.1]', 'https://[ff02::1]', 'https://[2001:db8::1]'])(
        'rejects %s before sending a request', async target => {
            const fetcher = jest.fn<typeof fetch>();
            await expect(fetchPublicHttps(target, {}, fetcher)).rejects.toThrow(/refusing/);
            expect(fetcher).not.toHaveBeenCalled();
        });

    test.each(['127.1', '0x7f000001', '0177.0.0.1', '2130706433', 'fe80::1%eth0', '::ffff:10.0.0.1',
        '[ff02::1]', '[2001:db8::1]', '', 'localhost.'])(
        'classifies nonpublic host %s', host => expect(isPrivateHostname(host)).toBe(true));
    test.each(['8.8.8.8', '2606:4700:4700::1111', 'public.example'])(
        'allows public host %s', host => expect(isPrivateHostname(host)).toBe(false));

    test.each(['http://public.example/next', 'https://169.254.169.254/latest/meta-data'])(
        'rechecks redirect destination %s and releases the previous body', async location => {
            const response = new Response('redirect body', { status: 302, headers: { location } });
            const cancel = jest.spyOn(response.body!, 'cancel');
            const fetcher = jest.fn<typeof fetch>().mockResolvedValue(response);
            await expect(fetchPublicHttps('https://public.example', {}, fetcher)).rejects.toThrow(/refusing/);
            expect(fetcher).toHaveBeenCalledTimes(1);
            expect(cancel).toHaveBeenCalledTimes(1);
        });

    test('rejects a redirect without Location and cancels its body', async () => {
        const response = new Response('body', { status: 302 });
        const cancel = jest.spyOn(response.body!, 'cancel');
        const fetcher = jest.fn<typeof fetch>().mockResolvedValue(response);
        await expect(fetchPublicHttps('https://public.example', {}, fetcher)).rejects.toThrow('redirect with no location');
        expect(cancel).toHaveBeenCalledTimes(1);
    });

    test('limits redirect loops and follows relative locations manually', async () => {
        const fetcher = jest.fn<typeof fetch>().mockImplementation(async () => new Response(null,
            { status: 307, headers: { location: '/loop' } }));
        await expect(fetchPublicHttps('https://public.example/start', {}, fetcher)).rejects.toThrow('too many redirects');
        expect(fetcher).toHaveBeenCalledTimes(4);
        expect(fetcher).toHaveBeenLastCalledWith('https://public.example/loop', { redirect: 'manual' });
    });

    test('returns a successful relative redirect response and does not follow 304', async () => {
        const ok = new Response('ok');
        const fetcher = jest.fn<typeof fetch>()
            .mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: '/done' } }))
            .mockResolvedValueOnce(ok);
        expect(await fetchPublicHttps('https://public.example/start', {}, fetcher)).toBe(ok);
        expect(fetcher).toHaveBeenLastCalledWith('https://public.example/done', { redirect: 'manual' });
        const unchanged = new Response(null, { status: 304 });
        fetcher.mockReset().mockResolvedValue(unchanged);
        expect(await fetchPublicHttps('https://public.example', {}, fetcher)).toBe(unchanged);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
});

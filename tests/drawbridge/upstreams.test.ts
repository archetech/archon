import { UPSTREAMS, upstreamURL } from '../../services/drawbridge/server/src/upstreams.ts';

describe('upstreamURL', () => {
    describe('under Compose', () => {
        it('points an empty URL at the container when its profile is enabled', () => {
            const env = { ARCHON_COMPOSE_PROFILES: 'hyperswarm, drawbridge,herald', ARCHON_HERALD_URL: '' };

            expect(upstreamURL(UPSTREAMS.herald, env)).toBe('http://herald:4230');
        });

        it('leaves an empty URL off when its profile is not enabled', () => {
            const env = { ARCHON_COMPOSE_PROFILES: 'drawbridge,lightning-extra', ARCHON_LIGHTNING_MEDIATOR_URL: '' };

            expect(upstreamURL(UPSTREAMS.lightningMediator, env)).toBe('');
            expect(upstreamURL(UPSTREAMS.cashuMint, { ARCHON_COMPOSE_PROFILES: '' })).toBe('');
        });

        it('uses a URL that is set, with or without its profile', () => {
            expect(upstreamURL(UPSTREAMS.explorer, { ARCHON_COMPOSE_PROFILES: '', ARCHON_EXPLORER_URL: 'https://explorer.example' }))
                .toBe('https://explorer.example');
            expect(upstreamURL(UPSTREAMS.didcomm, { ARCHON_COMPOSE_PROFILES: 'didcomm', ARCHON_DIDCOMM_URL: 'http://relay:9000' }))
                .toBe('http://relay:9000');
        });

        it.each(Object.values(UPSTREAMS))('resolves $variable from the $profile profile', upstream => {
            expect(upstreamURL(upstream, { ARCHON_COMPOSE_PROFILES: upstream.profile })).toBe(upstream.container);
        });
    });

    describe('outside Compose', () => {
        it('falls back to localhost when the URL is unset', () => {
            expect(upstreamURL(UPSTREAMS.herald, {})).toBe('http://localhost:4230');
            expect(upstreamURL(UPSTREAMS.cashuMint, {})).toBe('');
        });

        it('turns the service off when the URL is empty', () => {
            expect(upstreamURL(UPSTREAMS.herald, { ARCHON_HERALD_URL: '' })).toBe('');
        });
    });
});

import { execFileSync } from 'node:child_process';

it.each(['module', 'commonjs'])('selects the protected transport automatically in Node %s', format => {
    const load = format === 'module'
        ? "const net = await import('@didcid/common/net');"
        : "const net = require('@didcid/common/net');";
    const script = load + `
        globalThis.fetch = async (_url, init) => {
            if (!init.dispatcher) throw new Error('missing protected dispatcher');
            return new Response('{}');
        };
        net.fetchPublicHttps('https://8.8.8.8/').catch(error => { console.error(error); process.exitCode = 1; });
    `;
    expect(() => execFileSync(process.execPath, ['--input-type=' + format, '-e', script])).not.toThrow();
});

it.each(['module', 'commonjs'])('selects the portable transport under browser conditions for %s', format => {
    const load = format === 'module'
        ? "const net = await import('@didcid/common/net');"
        : "const net = require('@didcid/common/net');";
    const script = load + `
        globalThis.fetch = async (_url, init) => {
            if (init.dispatcher) throw new Error('Node transport in browser export');
            return new Response('{}');
        };
        net.fetchPublicHttps('https://8.8.8.8/').catch(error => { console.error(error); process.exitCode = 1; });
    `;
    expect(() => execFileSync(process.execPath, ['--conditions=browser', '--input-type=' + format, '-e', script])).not.toThrow();
});

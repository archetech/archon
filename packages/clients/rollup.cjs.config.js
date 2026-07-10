import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';

const config = {
    input: {
        'index': 'dist/esm/index.js',
        'gatekeeper-client': 'dist/esm/gatekeeper-client.js',
        'drawbridge-client': 'dist/esm/drawbridge-client.js',
        'keymaster-client': 'dist/esm/keymaster-client.js',
    },
    output: {
        dir: 'dist/cjs',
        format: 'cjs',
        exports: 'named',
        entryFileNames: '[name].cjs',
        chunkFileNames: '[name]-[hash].cjs'
    },
    external: ['axios', 'buffer'],
    plugins: [
        resolve({ preferBuiltins: true }),
        commonjs()
    ]
};

export default config;

import { applyChanges, envValues, formatValue, parseEnv, parseValue } from '../../services/node-runner/server/src/envfile.ts';

describe('parseValue', () => {
    it.each([
        ['plain', 'plain'],
        ['  spaced  ', 'spaced'],
        ['value # comment', 'value'],
        ['a#b', 'a#b'],
        ["'single # kept'", 'single # kept'],
        ["'$HOME'", '$HOME'],
        ['"double \\"quoted\\" \\\\ \\$x"', 'double "quoted" \\ $x'],
        ['"line\\nbreak"', 'line\nbreak'],
        ['', ''],
    ])('reads %s', (raw, value) => {
        expect(parseValue(raw)).toBe(value);
    });
});

describe('parseEnv and envValues', () => {
    it('keeps comments and blank lines and lets the last assignment win', () => {
        const lines = parseEnv('# heading\n\nA=1\n# B=commented\nexport C=3\nA=2\n');

        expect(lines.map(l => l.raw)).toEqual(['# heading', '', 'A=1', '# B=commented', 'export C=3', 'A=2']);
        expect(Object.fromEntries(envValues(lines))).toEqual({ A: '2', C: '3' });
    });
});

describe('formatValue', () => {
    it('quotes only what needs it, and keeps $ literal', () => {
        expect(formatValue('http://drawbridge:4222/path')).toBe('http://drawbridge:4222/path');
        expect(formatValue('')).toBe('');
        expect(formatValue('two words')).toBe("'two words'");
        expect(formatValue('$NOT_A_VAR')).toBe("'$NOT_A_VAR'");
        expect(formatValue("it's $x")).toBe('"it\'s \\$x"');
    });

    it('refuses a value spanning lines', () => {
        expect(() => formatValue('a\nb')).toThrow('several lines');
    });

    it('round-trips through parseValue', () => {
        // eslint-disable-next-line no-template-curly-in-string
        for (const value of ['plain', 'with space', "it's", 'dollar $HOME ${X}', 'q " b \\ s', '# hash', "both ' \" $V", 'x #y']) {
            expect(parseValue(formatValue(value))).toBe(value);
        }
    });
});

describe('applyChanges', () => {
    const original = '# General\nARCHON_NODE_NAME=old # my node\n\n# Keep me\nUNKNOWN=x\nARCHON_DEBUG=false\nARCHON_DEBUG=true\n';

    it('rewrites only the changed line, keeping everything else byte for byte', () => {
        const out = applyChanges(original, { ARCHON_NODE_NAME: 'new name' });

        expect(out).toBe("# General\nARCHON_NODE_NAME='new name'\n\n# Keep me\nUNKNOWN=x\nARCHON_DEBUG=false\nARCHON_DEBUG=true\n");
    });

    it('changes the assignment that takes effect when a key repeats', () => {
        const out = applyChanges(original, { ARCHON_DEBUG: 'false' });

        expect(out.split('\n').slice(-3)).toEqual(['ARCHON_DEBUG=false', 'ARCHON_DEBUG=false', '']);
        expect(envValues(parseEnv(out)).get('ARCHON_DEBUG')).toBe('false');
    });

    it('appends new keys after a blank line', () => {
        expect(applyChanges('A=1', { B: '2', C: '' })).toBe('A=1\n\nB=2\nC=\n');
        expect(applyChanges('', { B: '2' })).toBe('B=2\n');
    });

    it('refuses an invalid key', () => {
        expect(() => applyChanges('', { 'BAD KEY': '1' })).toThrow('Not a valid setting name');
    });
});

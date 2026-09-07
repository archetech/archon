import { missingPassphraseMessage, resolvePassphrase } from '../../packages/keymaster/src/passphrase.ts';

// The quickstart taught `export ARCHON_PASSPHRASE=...` as the only way in, for
// a secret that encrypts a wallet holding Lightning funds — into shell history,
// /proc/<pid>/environ, and every child the shell spawns after it (#977).

function sources(env: Record<string, string | undefined>, overrides: Partial<Parameters<typeof resolvePassphrase>[0]> = {}) {
    return {
        env,
        readFile: () => { throw new Error('no file expected'); },
        interactive: false,
        prompt: async () => { throw new Error('no prompt expected'); },
        ...overrides,
    };
}

describe('resolvePassphrase', () => {
    it('takes the environment first, so automation is unaffected', async () => {
        expect(await resolvePassphrase(sources({ ARCHON_PASSPHRASE: 'from-env' }))).toBe('from-env');
    });

    it('still reads the older name', async () => {
        expect(await resolvePassphrase(sources({ ARCHON_ENCRYPTED_PASSPHRASE: 'older' }))).toBe('older');
    });

    it('reads a file when the environment holds nothing', async () => {
        const read = await resolvePassphrase(sources({ ARCHON_PASSPHRASE_FILE: '/run/secrets/pass' }, {
            readFile: (path) => {
                expect(path).toBe('/run/secrets/pass');
                return 'from-file\n';
            },
        }));

        expect(read).toBe('from-file');
    });

    // Only the newline an editor leaves. Spaces could be the passphrase.
    it('keeps everything but one trailing newline', async () => {
        const read = await resolvePassphrase(sources({ ARCHON_PASSPHRASE_FILE: '/f' }, {
            readFile: () => '  two words  \r\n',
        }));

        expect(read).toBe('  two words  ');
    });

    // A path that is wrong is an error, not an invitation to type something
    // else -- silently prompting would let a typo mint a different wallet.
    it('fails on an unreadable file rather than falling through to a prompt', async () => {
        const attempt = resolvePassphrase(sources({ ARCHON_PASSPHRASE_FILE: '/missing' }, {
            readFile: () => { throw new Error('ENOENT'); },
            interactive: true,
            prompt: async () => 'typed',
        }));

        await expect(attempt).rejects.toThrow('ENOENT');
    });

    it('asks when there is someone to ask', async () => {
        const asked: string[] = [];
        const read = await resolvePassphrase(sources({}, {
            interactive: true,
            prompt: async (query) => { asked.push(query); return 'typed'; },
        }));

        expect(read).toBe('typed');
        expect(asked).toHaveLength(1);
    });

    // Asking a pipe hangs the script that opened it.
    it('does not ask when nothing is attached', async () => {
        let asked = false;
        const read = await resolvePassphrase(sources({}, {
            prompt: async () => { asked = true; return 'typed'; },
        }));

        expect(read).toBeUndefined();
        expect(asked).toBe(false);
    });

    it('treats an empty answer as no passphrase', async () => {
        expect(await resolvePassphrase(sources({}, { interactive: true, prompt: async () => '' }))).toBeUndefined();
    });
});

describe('missingPassphraseMessage', () => {
    it('never tells a non-interactive caller to answer a prompt', () => {
        const lines = missingPassphraseMessage(false).join(' ');

        expect(lines).toContain('no terminal');
        expect(lines).toContain('ARCHON_PASSPHRASE_FILE');
    });

    // The old message said "export ARCHON_PASSPHRASE=...", which is the habit
    // this change exists to stop teaching.
    it('does not instruct anyone to export the secret', () => {
        for (const interactive of [true, false]) {
            expect(missingPassphraseMessage(interactive).join(' ')).not.toContain('export ');
        }
    });
});

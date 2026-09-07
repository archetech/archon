// Where a CLI gets the wallet passphrase.
//
// The environment is the worst of the available places for it: it persists in
// shell history, is readable from /proc/<pid>/environ, is inherited by every
// child the shell spawns afterwards, and lands in CI logs. Automation still
// needs it, so it stays supported -- but it should not be the only way, and it
// should not be the one a first-time reader is taught (#977).

export interface PassphraseSources {
    env: Record<string, string | undefined>;
    // Throws if a configured file cannot be read, which must not fall through
    // to a prompt: an explicit path that is wrong is an error, not an
    // invitation to type something else.
    readFile: (path: string) => string;
    fileExists: (path: string) => boolean;
    // Where a prompted passphrase is offered a home. Read before prompting, so
    // accepting that offer once ends the asking -- otherwise every command in a
    // session asks again, which is what the environment variable was buying.
    savedFile: string;
    // A prompt is only possible when someone is there to answer it. Asking a
    // pipe hangs the script that opened it.
    interactive: boolean;
    prompt: (query: string) => Promise<string>;
}

// Which of them supplied it. Only a prompted one is worth offering to save.
export type PassphraseSource = 'environment' | 'file' | 'saved' | 'prompt';

export interface ResolvedPassphrase {
    passphrase: string;
    from: PassphraseSource;
}

export const PASSPHRASE_PROMPT = 'Wallet passphrase: ';

// One trailing newline, which is what an editor or `echo >` leaves and what
// the Docker secrets convention expects to be ignored. Nothing else: the rest
// could be the passphrase.
//
// A file holding nothing else is a mistake rather than an empty passphrase.
// Passing it on encrypts a wallet with no secret at all, which the Python
// Keymaster accepts, so it is refused here for both flavors.
function fromFile(path: string, text: string): string {
    const passphrase = text.replace(/\r?\n$/, '');

    if (!passphrase) {
        throw new Error(`the passphrase file ${path} is empty`);
    }

    return passphrase;
}

export async function resolvePassphrase(sources: PassphraseSources): Promise<ResolvedPassphrase | undefined> {
    const configured = sources.env.ARCHON_PASSPHRASE || sources.env.ARCHON_ENCRYPTED_PASSPHRASE;

    if (configured) {
        return { passphrase: configured, from: 'environment' };
    }

    const file = sources.env.ARCHON_PASSPHRASE_FILE;

    if (file) {
        return { passphrase: fromFile(file, sources.readFile(file)), from: 'file' };
    }

    if (sources.fileExists(sources.savedFile)) {
        return { passphrase: fromFile(sources.savedFile, sources.readFile(sources.savedFile)), from: 'saved' };
    }

    if (sources.interactive) {
        const answer = await sources.prompt(PASSPHRASE_PROMPT);

        return answer ? { passphrase: answer, from: 'prompt' } : undefined;
    }

    return undefined;
}

// What to tell someone who has not supplied one. A prompt they could have
// answered is only worth mentioning if they could have seen it.
export function missingPassphraseMessage(interactive: boolean): string[] {
    const options = [
        'Set ARCHON_PASSPHRASE_FILE to a file holding it, or ARCHON_PASSPHRASE for automation.',
    ];

    return interactive
        ? ['Error: no wallet passphrase given.', ...options]
        : [
            'Error: no wallet passphrase, and no terminal to ask on.',
            ...options,
        ];
}

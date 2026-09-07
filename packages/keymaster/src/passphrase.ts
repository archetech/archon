// Where a CLI gets the wallet passphrase.
//
// The environment is the worst of the available places for it: it persists in
// shell history, is readable from /proc/<pid>/environ, is inherited by every
// child the shell spawns afterwards, and lands in CI logs. Automation still
// needs it, so it stays supported -- but it should not be the only way, and it
// should not be the one a first-time reader is taught (#977).

export interface PassphraseSources {
    env: Record<string, string | undefined>;
    // Throws if the configured file cannot be read, which must not fall
    // through to a prompt: an explicit path that is wrong is an error, not an
    // invitation to type something else.
    readFile: (path: string) => string;
    // A prompt is only possible when someone is there to answer it. Asking a
    // pipe hangs the script that opened it.
    interactive: boolean;
    prompt: (query: string) => Promise<string>;
}

export const PASSPHRASE_PROMPT = 'Wallet passphrase: ';

export async function resolvePassphrase(sources: PassphraseSources): Promise<string | undefined> {
    const configured = sources.env.ARCHON_PASSPHRASE || sources.env.ARCHON_ENCRYPTED_PASSPHRASE;

    if (configured) {
        return configured;
    }

    const file = sources.env.ARCHON_PASSPHRASE_FILE;

    if (file) {
        // One trailing newline, which is what an editor or `echo >` leaves and
        // what the Docker secrets convention expects to be ignored. Nothing
        // else is trimmed: the rest could be the passphrase.
        return sources.readFile(file).replace(/\r?\n$/, '');
    }

    if (sources.interactive) {
        return await sources.prompt(PASSPHRASE_PROMPT) || undefined;
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

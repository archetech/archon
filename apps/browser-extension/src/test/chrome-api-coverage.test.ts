import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// The render tests stub chrome.*, and a missing member does not fail the way
// you would hope: the call happens inside a passive effect, after the
// assertions have already passed, so vitest reports an unhandled error and
// exits non-zero while every test prints green. It cost a CI round trip to
// notice, and only in CI -- the effect ordering differed locally.
//
// So rather than trusting the stub to keep up by hand, this reads what the
// source actually uses and checks each one resolves.

const SRC = path.resolve(__dirname, '..');

function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap(name => {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) {
            return name === 'test' ? [] : sourceFiles(full);
        }
        return /\.tsx?$/.test(name) ? [full] : [];
    });
}

// chrome.storage.onChanged.addListener -> ['storage', 'onChanged', 'addListener']
function usedPaths(): string[][] {
    const used = new Set<string>();

    for (const file of sourceFiles(SRC)) {
        const source = readFileSync(file, 'utf-8');
        for (const match of source.matchAll(/\bchrome((?:\.[a-zA-Z_$][\w$]*)+)/g)) {
            used.add(match[1].slice(1));
        }
    }

    return [...used].map(entry => entry.split('.'));
}

function resolve(root: unknown, segments: string[]): { ok: boolean; missingAt: string } {
    let current: any = root;

    for (const [index, segment] of segments.entries()) {
        // A declared member holding undefined is covered: chrome.runtime
        // .lastError is undefined at rest and the source guards it before
        // reading .message, so descending further would demand a stub for a
        // path that never exists in a real browser either.
        if (current === null || current === undefined) {
            return { ok: true, missingAt: '' };
        }

        if (!(segment in current)) {
            return { ok: false, missingAt: `chrome.${segments.slice(0, index + 1).join('.')}` };
        }

        current = current[segment];
    }

    return { ok: true, missingAt: '' };
}

describe('chrome API stub', () => {
    it('finds chrome usage in the source', () => {
        // Guard the guard: a regex that stopped matching would make the check
        // below vacuous.
        expect(usedPaths().length).toBeGreaterThan(5);
    });

    it('covers every chrome member the extension source touches', () => {
        // Named explicitly rather than inferred from capitalisation: these two
        // are erased before anything runs, but chrome.runtime.OnInstalledReason
        // .INSTALL is a real constant the background script compares against,
        // and a capitalisation rule would excuse it -- so deleting it from the
        // stub would leave this green.
        const typeOnly = new Set([
            'runtime.MessageSender',
            'storage.StorageChange',
        ]);

        const missing = usedPaths()
            .filter(segments => !typeOnly.has(segments.join('.')))
            .map(segments => resolve((globalThis as any).chrome, segments))
            .filter(result => !result.ok)
            .map(result => result.missingAt)
            .sort();

        expect([...new Set(missing)]).toStrictEqual([]);
    });
});

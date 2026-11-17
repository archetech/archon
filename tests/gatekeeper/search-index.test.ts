import { jest } from '@jest/globals';

import SearchIndex from '../../packages/gatekeeper/src/search-index.ts';

type Doc = Record<string, unknown>;

// What a query returned before there were indexes: every document, in insertion
// order, tested against the condition. Kept here as the reference.
function getPath(root: unknown, path: string): unknown {
    if (!path || root == null) return undefined;
    const clean = path.startsWith('$.') ? path.slice(2) : path.startsWith('$') ? path.slice(1) : path;
    if (!clean) return root;
    let cur: unknown = root;
    for (const part of clean.split('.')) {
        if (cur == null) return undefined;
        const idx = Number.isInteger(+part) ? +part : null;
        if (idx !== null && Array.isArray(cur)) { cur = cur[idx]; continue; }
        if (typeof cur === 'object') cur = (cur as Doc)[part];
        else return undefined;
    }
    return cur;
}

function scan(docs: Map<string, Doc>, rawPath: string, list: unknown[]): string[] {
    const result: string[] = [];
    for (const [did, doc] of docs) {
        let match = false;
        if (/\[\*]$/.test(rawPath)) {
            const arr = getPath(doc, rawPath.replace(/\[\*]$/, ''));
            if (Array.isArray(arr)) match = arr.some(v => list.includes(v));
        } else if (/\[\*]\./.test(rawPath)) {
            const [prefix, suffix] = rawPath.split('[*].');
            const arr = getPath(doc, prefix);
            if (Array.isArray(arr)) match = arr.some(el => list.includes(getPath(el, suffix)));
        } else if (rawPath.endsWith('.*')) {
            const obj = getPath(doc, rawPath.slice(0, -2));
            if (obj && typeof obj === 'object' && !Array.isArray(obj)) match = Object.keys(obj).some(k => list.includes(k));
        } else if (rawPath.includes('.*.')) {
            const [prefix, suffix] = rawPath.split('.*.');
            const obj = getPath(doc, prefix);
            if (obj && typeof obj === 'object' && !Array.isArray(obj)) match = Object.values(obj).some(v => list.includes(getPath(v, suffix)));
        } else {
            match = list.includes(getPath(doc, rawPath));
        }
        if (match) result.push(did);
    }
    return result;
}

// An index and the same documents kept plainly, so every query can be checked.
function harness() {
    const index = new SearchIndex();
    const docs = new Map<string, Doc>();
    return {
        index,
        store(did: string, data?: Doc) {
            index.store(did, data ? { didDocumentData: data } : {});
            docs.set(did, data ?? {});
        },
        remove(did: string) {
            index.delete(did);
            docs.delete(did);
        },
        query(rawPath: string, list: unknown[]) {
            const found = index.queryDocs({ [rawPath]: { $in: list } });
            expect(found).toEqual(scan(docs, rawPath, list));
            return found;
        },
    };
}

function populated() {
    const h = harness();
    h.store('did:a', { post: { author: 'alice', tags: ['x', 'y'], n: 1, live: true } });
    h.store('did:b', { post: { author: 'bob', tags: ['y'], n: 2, live: false, note: null } });
    h.store('did:c', { post: { author: 'alice', tags: [], n: 1 } });
    h.store('did:d', { group: { members: [{ did: 'alice' }, { did: 'carol' }] } });
    h.store('did:e', { names: { alice: { role: 'owner' }, bob: { role: 'reader' } } });
    h.store('did:f');
    return h;
}

const CASES: [string, unknown[]][] = [
    ['post.author', ['alice']],
    ['post.author', ['alice', 'bob', 'nobody']],
    ['$.post.author', ['bob']],
    ['post.tags[*]', ['y']],
    ['post.tags.0', ['x']],
    ['group.members[*].did', ['carol', 'alice']],
    ['names.*', ['bob']],
    ['names.*.role', ['owner']],
    ['post.n', [1]],
    ['post.n', ['1']],
    ['post.live', [false]],
    ['post.note', [null]],
    ['post.missing', [null]],
    ['post', [{ author: 'bob' }]],
    ['post.tags', [['y']]],
    ['post.author', []],
];

describe('SearchIndex queries', () => {
    it.each(CASES)('answers %s in %j as a scan of every document would', (rawPath, list) => {
        const h = populated();
        // The first query builds the path's index and the second reads it.
        const first = h.query(rawPath, list);
        expect(h.query(rawPath, list)).toEqual(first);
    });

    it('tells a string from a number, and never matches an object or an array', () => {
        const h = populated();
        expect(h.query('post.n', [1])).toEqual(['did:a', 'did:c']);
        expect(h.query('post.n', ['1'])).toEqual([]);
        expect(h.query('post', [{ author: 'bob' }])).toEqual([]);
        expect(h.query('post.tags', [['y']])).toEqual([]);
    });

    it('follows updates and deletions, keeping results in insertion order', () => {
        const h = populated();
        expect(h.query('post.author', ['alice'])).toEqual(['did:a', 'did:c']);

        // An update moves a document between values and keeps its place.
        h.store('did:a', { post: { author: 'bob' } });
        h.store('did:b', { post: { author: 'alice' } });
        expect(h.query('post.author', ['alice'])).toEqual(['did:b', 'did:c']);
        expect(h.query('post.author', ['bob'])).toEqual(['did:a']);

        h.remove('did:c');
        expect(h.query('post.author', ['alice'])).toEqual(['did:b']);

        // A document stored again after deletion goes to the end, as in a scan.
        h.store('did:c', { post: { author: 'alice' } });
        h.store('did:g', { post: { author: 'alice' } });
        expect(h.query('post.author', ['alice'])).toEqual(['did:b', 'did:c', 'did:g']);

        h.index.clear();
        expect(h.index.queryDocs({ 'post.author': { $in: ['alice'] } })).toEqual([]);
        expect(h.index.size).toBe(0);
    });

    it('keeps only the most recently queried paths indexed, and rebuilds one that was dropped', () => {
        const h = populated();
        const paths = () => [...(h.index as unknown as { paths: Map<string, unknown> }).paths.keys()];
        for (let n = 0; n < 11; n++) {
            h.query(`unused.path${n}`, ['alice']);
            // Queried between each, so it is never the least recent.
            expect(h.query('post.author', ['alice'])).toEqual(['did:a', 'did:c']);
        }
        expect(paths()).toHaveLength(8);
        expect(paths()).toContain('post.author');
        expect(paths()).not.toContain('unused.path0');

        h.store('did:h', { post: { tags: ['y'] } });
        for (let n = 0; n < 8; n++) h.query(`other.path${n}`, ['alice']);
        expect(paths()).not.toContain('post.author');
        expect(h.query('post.author', ['alice'])).toEqual(['did:a', 'did:c']);
        expect(h.query('post.tags[*]', ['y'])).toEqual(['did:a', 'did:b', 'did:h']);
    });

    it('rejects a condition that is not a list', () => {
        const { index } = populated();
        expect(() => index.queryDocs({ 'post.author': { $eq: 'alice' } })).toThrow('Only {$in:[...]} supported');
        expect(index.queryDocs({})).toEqual([]);
    });

    it('answers a query without reading every document once its path is indexed', () => {
        const h = harness();
        for (let n = 0; n < 2000; n++) h.store(`did:${n}`, { post: { author: `author${n % 50}` } });
        h.query('post.author', ['author7']);
        // `values` is what reads a document. Building the index called it once
        // for each; a query on the built index must not call it at all.
        const values = jest.spyOn(h.index as unknown as { values: () => unknown[] }, 'values');
        try {
            expect(h.index.queryDocs({ 'post.author': { $in: ['author7'] } })).toHaveLength(40);
            expect(values).not.toHaveBeenCalled();
        } finally {
            values.mockRestore();
        }
    });
});

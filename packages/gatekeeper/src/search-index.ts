type JSONObject = Record<string, unknown>;

interface DidCidDocumentLike {
    didDocumentData?: unknown;
}

export default class SearchIndex {
    private docs = new Map<string, JSONObject>();
    // Each DID's place in insertion order, which is the order of a query's results.
    private order = new Map<string, number>();
    private next = 0;
    // For each query path: every value found at that path, and the DIDs that have
    // it there. A path's index is built the first time it is queried and kept
    // current after that. The Map's own order is least recently queried first.
    private paths = new Map<string, Map<string, Set<string>>>();
    // How many paths are kept indexed. Anyone can query any path, and each index
    // costs memory for every document with a value there, so the least recently
    // queried is dropped past this.
    private static readonly MAX_PATHS = 8;
    private static readonly ARRAY_WILDCARD_END = /\[\*]$/;
    private static readonly ARRAY_WILDCARD_MID = /\[\*]\./;

    store(did: string, doc: object): void {
        // Only index didDocumentData to focus on actual content
        const data = (doc as DidCidDocumentLike).didDocumentData;
        const stored = data && typeof data === 'object' ? JSON.parse(JSON.stringify(data)) as JSONObject : {};
        const previous = this.docs.get(did);
        for (const [path, index] of this.paths) {
            if (previous) this.forget(index, previous, path, did);
            this.remember(index, stored, path, did);
        }
        if (!this.order.has(did)) this.order.set(did, this.next++);
        this.docs.set(did, stored);
    }

    delete(did: string): void {
        const previous = this.docs.get(did);
        if (!previous) return;
        for (const [path, index] of this.paths) this.forget(index, previous, path, did);
        this.docs.delete(did);
        this.order.delete(did);
    }

    clear(): void {
        this.docs.clear();
        this.order.clear();
        this.paths.clear();
    }

    get size(): number {
        return this.docs.size;
    }

    searchDocs(q: string): string[] {
        const out: string[] = [];
        for (const [did, doc] of this.docs.entries()) {
            if (JSON.stringify(doc).includes(q)) out.push(did);
        }
        return out;
    }

    queryDocs(where: Record<string, unknown>): string[] {
        const entry = Object.entries(where)[0] as [string, unknown] | undefined;
        if (!entry) {
            return [];
        }
        const [rawPath, cond] = entry;
        if (typeof cond !== 'object' || cond === null || !Array.isArray((cond as { $in?: unknown }).$in)) {
            throw new Error('Only {$in:[...]} supported');
        }
        const list = (cond as { $in: unknown[] }).$in;

        const index = this.pathIndex(rawPath);
        const found = new Set<string>();
        for (const value of list) {
            const key = SearchIndex.key(value);
            if (key !== undefined) for (const did of index.get(key) ?? []) found.add(did);
        }
        return [...found].sort((a, b) => this.order.get(a)! - this.order.get(b)!);
    }

    // The index for this path, built from every document if the path has not been
    // queried lately. Only that first query reads every document.
    private pathIndex(rawPath: string): Map<string, Set<string>> {
        let index = this.paths.get(rawPath);
        if (index) {
            this.paths.delete(rawPath);
        } else {
            index = new Map();
            for (const [did, doc] of this.docs) this.remember(index, doc, rawPath, did);
            if (this.paths.size >= SearchIndex.MAX_PATHS) this.paths.delete(this.paths.keys().next().value!);
        }
        this.paths.set(rawPath, index);
        return index;
    }

    private remember(index: Map<string, Set<string>>, doc: JSONObject, rawPath: string, did: string): void {
        for (const value of this.values(doc, rawPath)) {
            const key = SearchIndex.key(value);
            if (key === undefined) continue;
            if (!index.has(key)) index.set(key, new Set());
            index.get(key)!.add(did);
        }
    }

    private forget(index: Map<string, Set<string>>, doc: JSONObject, rawPath: string, did: string): void {
        for (const value of this.values(doc, rawPath)) {
            const key = SearchIndex.key(value);
            const dids = key === undefined ? undefined : index.get(key);
            if (dids?.delete(did) && !dids.size) index.delete(key!);
        }
    }

    // A value as it compares: two values share a key exactly when one would be
    // found in a list holding the other. Objects and arrays are never found in a
    // list parsed from a request, so they have no key.
    private static key(value: unknown): string | undefined {
        if (value === null) return 'null';
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            return `${typeof value}:${value}`;
        }
        return undefined;
    }

    // The values a document offers at a query path. The document matches a query
    // when any of them is in the query's list.
    private values(doc: JSONObject, rawPath: string): unknown[] {
        if (SearchIndex.ARRAY_WILDCARD_END.test(rawPath)) {
            const arr = this.getPath(doc, rawPath.replace(SearchIndex.ARRAY_WILDCARD_END, ''));
            return Array.isArray(arr) ? arr : [];
        }
        if (SearchIndex.ARRAY_WILDCARD_MID.test(rawPath)) {
            const [prefix, suffix] = rawPath.split('[*].');
            const arr = this.getPath(doc, prefix);
            return Array.isArray(arr) ? arr.map(el => this.getPath(el, suffix)) : [];
        }
        if (rawPath.endsWith('.*')) {
            const obj = this.getPath(doc, rawPath.slice(0, -2));
            return obj && typeof obj === 'object' && !Array.isArray(obj) ? Object.keys(obj as Record<string, unknown>) : [];
        }
        if (rawPath.includes('.*.')) {
            const [prefix, suffix] = rawPath.split('.*.');
            const obj = this.getPath(doc, prefix);
            return obj && typeof obj === 'object' && !Array.isArray(obj)
                ? Object.values(obj as Record<string, unknown>).map(value => this.getPath(value, suffix))
                : [];
        }
        return [this.getPath(doc, rawPath)];
    }

    private getPath(root: unknown, path: string): unknown {
        if (!path || root == null) {
            return undefined;
        }

        const clean = path.startsWith('$.') ? path.slice(2) : path.startsWith('$') ? path.slice(1) : path;
        if (!clean) {
            return root;
        }

        const parts = clean.split('.');

        let cur: unknown = root;
        for (const rawPart of parts) {
            if (cur == null) {
                return undefined;
            }

            const idx = Number.isInteger(+rawPart) ? +rawPart : null;

            if (idx !== null && Array.isArray(cur)) {
                cur = cur[idx];
                continue;
            }

            if (typeof cur === 'object') {
                cur = (cur as Record<string, unknown>)[rawPart];
            } else {
                return undefined;
            }
        }
        return cur;
    }
}

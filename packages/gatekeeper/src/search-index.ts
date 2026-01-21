type JSONObject = Record<string, unknown>;

export default class SearchIndex {
    private docs = new Map<string, JSONObject>();
    private static readonly ARRAY_WILDCARD_END = /\[\*]$/;
    private static readonly ARRAY_WILDCARD_MID = /\[\*]\./;

    store(did: string, doc: object): void {
        this.docs.set(did, JSON.parse(JSON.stringify(doc)) as JSONObject);
    }

    get(did: string): object | null {
        const v = this.docs.get(did);
        return v ? JSON.parse(JSON.stringify(v)) : null;
    }

    delete(did: string): void {
        this.docs.delete(did);
    }

    clear(): void {
        this.docs.clear();
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

        const isKeyWildcard = rawPath.endsWith('.*');
        const isValueWildcard = rawPath.includes('.*.');
        const isArrayTail = SearchIndex.ARRAY_WILDCARD_END.test(rawPath);
        const isArrayMid = SearchIndex.ARRAY_WILDCARD_MID.test(rawPath);

        const result: string[] = [];

        for (const [did, doc] of this.docs.entries()) {
            let match = false;

            if (isArrayTail) {
                const basePath = rawPath.replace(SearchIndex.ARRAY_WILDCARD_END, '');
                const arr = this.getPath(doc, basePath);
                if (Array.isArray(arr)) {
                    match = arr.some(v => list.includes(v));
                }
            } else if (isArrayMid) {
                const [prefix, suffix] = rawPath.split('[*].');
                const arr = this.getPath(doc, prefix);
                if (Array.isArray(arr)) {
                    match = arr.some(el => list.includes(this.getPath(el, suffix)));
                }
            } else if (isKeyWildcard) {
                const basePath = rawPath.slice(0, -2);
                const obj = this.getPath(doc, basePath);
                if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
                    const keys = Object.keys(obj as Record<string, unknown>);
                    match = keys.some(k => list.includes(k));
                }
            } else if (isValueWildcard) {
                const [prefix, suffix] = rawPath.split('.*.');
                const obj = this.getPath(doc, prefix);
                if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
                    const values = Object.values(obj as Record<string, unknown>);
                    match = values.some(v => list.includes(this.getPath(v, suffix)));
                }
            } else {
                const val = this.getPath(doc, rawPath);
                match = list.includes(val);
            }

            if (match) {
                result.push(did);
            }
        }

        return result;
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

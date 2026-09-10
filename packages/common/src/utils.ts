export function copyJSON<T>(json: T): T {
    return JSON.parse(JSON.stringify(json)) as T;
}

export function compareOrdinals(a: number[], b: number[]): -1 | 0 | 1 {
    // An ordinal is a list of integers
    // Return -1 if a < b, 0 if a == b, 1 if a > b

    const minLength = Math.min(a.length, b.length);

    for (let i = 0; i < minLength; i++) {
        if (a[i] < b[i]) {
            return -1;
        }
        if (a[i] > b[i]) {
            return 1;
        }
    }

    // If all compared elements are equal, the longer list is considered greater
    if (a.length < b.length) {
        return -1;
    }

    if (a.length > b.length) {
        return 1;
    }

    return 0;
}

// The proofs on a document, however it carries them: the Data Integrity model
// allows a single object or a set, and everything reading a proof goes through
// this rather than assuming a shape.
//
// Generic over the proof type, so this stays free of the credential types in
// @didcid/clients -- which are a types-only subpath and cannot be imported for
// their runtime value.
export function proofsOf<T>(obj: { proof?: T | T[] } | null | undefined): T[] {
    if (!obj?.proof) {
        return [];
    }

    return Array.isArray(obj.proof) ? obj.proof : [obj.proof];
}

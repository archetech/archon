// The two helpers the compiled validators call.

// The length of a string in Unicode code points, which is how the schemas count.
export function ucs2length(text: string): number {
    let length = 0;

    for (let index = 0; index < text.length; index++) {
        const unit = text.charCodeAt(index);

        // A high surrogate followed by a low one is a single code point.
        if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length) {
            const next = text.charCodeAt(index + 1);
            if (next >= 0xdc00 && next <= 0xdfff) index++;
        }
        length++;
    }

    return length;
}

// Whether two JSON values are the same value.
export function equal(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;

    if (Array.isArray(a) && Array.isArray(b)) {
        return a.length === b.length && a.every((item, index) => equal(item, b[index]));
    }

    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = Object.keys(left);

    return keys.length === Object.keys(right).length
        && keys.every(key => Object.prototype.hasOwnProperty.call(right, key) && equal(left[key], right[key]));
}

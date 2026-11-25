// One value as one segment of a request's path, or one value of its query.
//
// A value put into a path as it is can name another path: a slash starts a new
// segment, and a segment of dots is taken away with the one before it when the
// address is read, so `x/../../ipfs/stream/y` in the place of a DID asks for
// something that is no DID. Encoded, it is one segment whatever it holds, and
// the service finds no such DID.
//
// A colon is left as it is: it is no separator in a path, and DIDs and
// registry names are full of them.
//
// A value that is nothing but one or two dots cannot be a segment at all. An
// address is read with such a segment taken away, and with `%2E` taken for a
// dot, so no encoding of it arrives as itself; and any other spelling of it
// would arrive as another name, which may be something's. It is refused before
// anything is sent.
export function segment(value: string | number | undefined): string {
    const text = String(value);

    if (text === '.' || text === '..') {
        throw new Error(`Invalid parameter: "${text}" cannot be part of a request's path`);
    }

    return encodeURIComponent(text).replace(/%3A/gi, ':');
}

// One value as one segment of a request's path, or one value of its query.
//
// A value put into a path as it is can name another path: a slash starts a new
// segment, and a segment of dots is taken away with the one before it when the
// address is read, so `x/../../ipfs/stream/y` in the place of a DID asks for
// something that is no DID. Encoded, it is one segment whatever it holds, and
// the service finds no such DID.
//
// A colon is left as it is: it is no separator in a path, and DIDs and
// registry names are full of them. A value that is nothing but one or two dots
// cannot be made a segment by encoding its dots, since an address is read with
// `%2E` taken for a dot, so its percent signs are encoded as well: the service
// is asked for a name no DID has.
export function segment(value: string | number | undefined): string {
    const encoded = encodeURIComponent(String(value)).replace(/%3A/gi, ':');

    return encoded === '.' || encoded === '..' ? encoded.replace(/\./g, '%252E') : encoded;
}

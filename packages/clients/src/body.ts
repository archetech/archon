// The body of a request that uploads an async iterable of bytes.
//
// axios sends a Node stream (anything with `pipe`) as it reads it, and a
// Uint8Array as its bytes, but serializes any other object as JSON, so an
// async generator would arrive as `{}`. A Node stream is passed on as it is;
// any other iterable is read into one Uint8Array first, which works the same
// in Node and in a browser. A chunk that is not bytes is refused.
export async function uploadBody(
    stream: AsyncIterable<Uint8Array>
): Promise<AsyncIterable<Uint8Array> | Uint8Array> {
    if (typeof (stream as { pipe?: unknown })?.pipe === 'function') {
        return stream;
    }

    const chunks: Uint8Array[] = [];
    let length = 0;

    for await (const chunk of stream) {
        // isView rather than instanceof, which fails for bytes from another realm
        if (!ArrayBuffer.isView(chunk)) {
            throw new TypeError('Invalid parameter: a stream must yield Uint8Array chunks');
        }
        // A copy, since a source may fill one buffer again for its next chunk
        chunks.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength).slice());
        length += chunk.byteLength;
    }

    // A buffer of its own, since axios sends the whole buffer under a view
    const body = new Uint8Array(length);
    let offset = 0;

    for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
    }

    return body;
}

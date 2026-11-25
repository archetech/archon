export interface JSONEncodingOptions {
    canonical?: boolean;
}

export interface IPFSClient {
    addText(text: string): Promise<string>;
    // `limit` is the most bytes that are read. What a CID names may be any
    // size, and is whatever whoever made it chose: a read that passes the
    // limit stops and throws ContentTooLargeError, with no more held than that.
    getText(cid: string, limit?: number): Promise<string>;
    addData(data: Buffer): Promise<string>;
    getData(cid: string, limit?: number): Promise<Buffer>;
    addDataStream(stream: AsyncIterable<Uint8Array>): Promise<string>;
    getDataStream(cid: string): AsyncIterable<Uint8Array>;
    addJSON(json: any, options?: JSONEncodingOptions): Promise<string>;
    getJSON(cid: string): Promise<any>;
}

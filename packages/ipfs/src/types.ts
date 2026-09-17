export interface IPFSClient {
    addText(text: string): Promise<string>;
    getText(cid: string): Promise<string>;
    addData(data: Buffer): Promise<string>;
    getData(cid: string): Promise<Buffer>;
    addDataStream(stream: AsyncIterable<Uint8Array>): Promise<string>;
    getDataStream(cid: string): AsyncIterable<Uint8Array>;
    addJSON(json: any): Promise<string>;
    getJSON(cid: string): Promise<any>;
}

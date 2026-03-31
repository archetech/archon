declare module 'fetch-socks' {
    export function socksDispatcher(options: {
        type: 5;
        host: string;
        port: number;
    }): unknown;
}

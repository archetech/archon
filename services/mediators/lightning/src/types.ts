export interface LightningMediatorConfig {
    port: number;
    bindAddress: string;
    redisUrl: string;
    clnRestUrl: string;
    clnRune: string;
    lnbitsUrl: string;
    publicHost: string;
    torProxy: string;
}

export interface ReadinessStatus {
    ready: boolean;
    dependencies: {
        redis: boolean;
        clnConfigured: boolean;
        lnbitsConfigured: boolean;
    };
}

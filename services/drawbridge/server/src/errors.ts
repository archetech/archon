export class DrawbridgeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DrawbridgeError';
    }
}

export class PaymentRequiredError extends DrawbridgeError {
    constructor(detail?: string) {
        super(detail ? `Payment required: ${detail}` : 'Payment required');
        this.name = 'PaymentRequiredError';
    }
}

export class InvalidMacaroonError extends DrawbridgeError {
    constructor(detail?: string) {
        super(detail ? `Invalid macaroon: ${detail}` : 'Invalid macaroon');
        this.name = 'InvalidMacaroonError';
    }
}

export class MacaroonRevokedError extends DrawbridgeError {
    constructor() {
        super('Macaroon revoked');
        this.name = 'MacaroonRevokedError';
    }
}

export class PaymentVerificationError extends DrawbridgeError {
    constructor(detail?: string) {
        super(detail ? `Payment verification failed: ${detail}` : 'Payment verification failed');
        this.name = 'PaymentVerificationError';
    }
}

export class RateLimitExceededError extends DrawbridgeError {
    constructor() {
        super('Rate limit exceeded');
        this.name = 'RateLimitExceededError';
    }
}

export class InsufficientScopeError extends DrawbridgeError {
    constructor(detail?: string) {
        super(detail ? `Insufficient scope: ${detail}` : 'Insufficient scope');
        this.name = 'InsufficientScopeError';
    }
}

export class LightningUnavailableError extends DrawbridgeError {
    constructor(detail?: string) {
        super(detail ? `Lightning service unavailable: ${detail}` : 'Lightning service unavailable');
        this.name = 'LightningUnavailableError';
    }
}

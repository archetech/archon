export class LightningMediatorError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'LightningMediatorError';
    }
}

export class LightningUnavailableError extends LightningMediatorError {
    constructor(detail?: string) {
        super(detail ? `Lightning service unavailable: ${detail}` : 'Lightning service unavailable');
        this.name = 'LightningUnavailableError';
    }
}

export class LightningPaymentError extends LightningMediatorError {
    constructor(detail?: string) {
        super(detail || 'Lightning payment failed');
        this.name = 'LightningPaymentError';
    }
}

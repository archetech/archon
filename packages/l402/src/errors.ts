import { ArchonError } from '@didcid/common/errors';

export class L402Error extends ArchonError {
    static type = 'L402';

    constructor(detail?: string) {
        super(L402Error.type, detail);
    }
}

export class PaymentRequiredError extends ArchonError {
    static type = 'Payment required';

    constructor(detail?: string) {
        super(PaymentRequiredError.type, detail);
    }
}

export class InvalidMacaroonError extends ArchonError {
    static type = 'Invalid macaroon';

    constructor(detail?: string) {
        super(InvalidMacaroonError.type, detail);
    }
}

export class MacaroonRevokedError extends ArchonError {
    static type = 'Macaroon revoked';

    constructor(detail?: string) {
        super(MacaroonRevokedError.type, detail);
    }
}

export class PaymentVerificationError extends ArchonError {
    static type = 'Payment verification failed';

    constructor(detail?: string) {
        super(PaymentVerificationError.type, detail);
    }
}

export class RateLimitExceededError extends ArchonError {
    static type = 'Rate limit exceeded';

    constructor(detail?: string) {
        super(RateLimitExceededError.type, detail);
    }
}

export class InsufficientScopeError extends ArchonError {
    static type = 'Insufficient scope';

    constructor(detail?: string) {
        super(InsufficientScopeError.type, detail);
    }
}

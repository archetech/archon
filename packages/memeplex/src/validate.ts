import * as validators from './validators.generated.js';

// Validity of the `memeplex`, `memeplexGrant` and `memeplexGrantRequest` members of
// an asset's data under `v: 1`: the published schema, then the checks a schema
// cannot express. Validity says nothing about who published an object; that is
// attribution.

export const KINDS = ['post', 'paper', 'reply', 'rating', 'tag'] as const;
export type Kind = typeof KINDS[number];

// 'valid', or the first thing that makes the value invalid.
//
// 'unsupported' is neither: the value states an integer `v` these rules do not
// cover, and a verifier that knows that `v` may find it valid.
export type Validity =
    | 'valid'
    | 'unsupported'
    // `v` is absent or is not an integer.
    | 'version'
    // `kind` is absent, is not a string, or names no core kind.
    | 'kind'
    // The value does not match its schema.
    | 'schema'
    // A rating's `min`, `max` and `rating` are not in order.
    | 'rating-bounds'
    // A paper's `authors` does not include its `author`.
    | 'paper-authors'
    // A grant's or a grant request's `expiresAt` is not a real instant.
    | 'expiry-instant';

type Compiled = (data: unknown) => boolean;
const compiled = validators as unknown as Record<Kind | 'grant' | 'grantRequest', Compiled>;

// Which rules a value asks for: undefined when they are these.
function rules(data: unknown): Validity | undefined {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return 'schema';
    const { v } = data as Record<string, unknown>;
    if (!Number.isInteger(v)) return 'version';
    return v === 1 ? undefined : 'unsupported';
}

// Counted here, not by Date, which reads a year below 100 as one in the 1900s.
function isInstant(value: string): boolean {
    const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?Z$/.exec(value);
    if (!parts) return false;
    const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number);
    if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
    return day >= 1 && day <= days;
}

// An object, by the schema its own `kind` names.
export function validateObject(memeplex: unknown): Validity {
    const other = rules(memeplex);
    if (other) return other;

    const value = memeplex as Record<string, any>;
    const kind = KINDS.find(name => name === value.kind);
    if (!kind) return 'kind';
    if (!compiled[kind](value)) return 'schema';

    if (kind === 'rating' && !(value.min < value.max && value.min <= value.rating && value.rating <= value.max)) {
        return 'rating-bounds';
    }
    if (kind === 'paper' && !value.authors.includes(value.author)) return 'paper-authors';

    return 'valid';
}

function validateScope(name: 'grant' | 'grantRequest', data: unknown): Validity {
    const other = rules(data);
    if (other) return other;

    const value = data as Record<string, any>;
    if (!compiled[name](value)) return 'schema';
    if (value.expiresAt !== undefined && !isInstant(value.expiresAt)) return 'expiry-instant';

    return 'valid';
}

export function validateGrant(memeplexGrant: unknown): Validity {
    return validateScope('grant', memeplexGrant);
}

export function validateGrantRequest(memeplexGrantRequest: unknown): Validity {
    return validateScope('grantRequest', memeplexGrantRequest);
}

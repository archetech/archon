import { readFileSync } from 'node:fs';
import * as ajv2020 from 'ajv/dist/2020.js';

// Validates the `memeplex`, `memeplexGrant` or `memeplexGrantRequest` member of an
// asset's data as docs/plans/memeplex-reference-1436.md defines it for `v: 1`: the
// published schema, then the checks a schema cannot express.

export const SCHEMAS = ['post', 'paper', 'reply', 'rating', 'tag', 'grant', 'grant-request'] as const;
export type SchemaName = typeof SCHEMAS[number];

export const KINDS = ['post', 'paper', 'reply', 'rating', 'tag'] as const;

// 'valid', or the first thing that makes the value invalid. 'unsupported' is neither:
// the value states an integer `v` these rules do not cover. A `v` that is absent or
// not an integer is 'version', and a `kind` that is absent or names no core kind is
// 'kind': a value that does not say which rules and which schema apply to it is
// invalid, not unsupported.
export type Outcome = 'valid' | 'unsupported' | 'version' | 'kind' | 'schema' | 'rating-bounds' | 'paper-authors' | 'expiry-instant';

export function schemaPath(name: SchemaName): string {
    return new URL(`../../share/schema/memeplex/v1/${name}.json`, import.meta.url).pathname;
}

export function readSchema(name: SchemaName): Record<string, any> {
    return JSON.parse(readFileSync(schemaPath(name), 'utf8'));
}

type Validator = (data: unknown) => boolean;
// The schemas name fields in `required` that the same subschema does not define, and
// leave some subschemas untyped. Both are ordinary JSON Schema that ajv's strict mode
// objects to; the rest of strict mode, which rejects unknown keywords, stays on.
const Ajv2020 = ((ajv2020 as any).default?.default ?? (ajv2020 as any).default ?? ajv2020) as new (options: object) => {
    compile(schema: object): Validator;
};
const compiled = new Map<SchemaName, Validator>();

function matchesSchema(name: SchemaName, data: unknown): boolean {
    let validator = compiled.get(name);
    if (!validator) {
        validator = new Ajv2020({ strictRequired: false, strictTypes: false }).compile(readSchema(name));
        compiled.set(name, validator);
    }
    return validator(data);
}

function isInstant(value: string): boolean {
    const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?Z$/.exec(value);
    if (!parts) return false;
    const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number);
    if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
    // Counted here, not by Date, which reads a year below 100 as one in the 1900s.
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
    return day >= 1 && day <= days;
}

// Which rules a value asks for: undefined when they are these.
function rules(data: unknown): Outcome | undefined {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return 'schema';
    const { v } = data as Record<string, unknown>;
    if (!Number.isInteger(v)) return 'version';
    return v === 1 ? undefined : 'unsupported';
}

// An object, by the schema its `kind` names.
export function validateObject(data: unknown): Outcome {
    const other = rules(data);
    if (other) return other;
    const { kind } = data as Record<string, unknown>;
    const core = KINDS.find(name => name === kind);
    return core ? validate(core, data) : 'kind';
}

export function validate(name: SchemaName, data: unknown): Outcome {
    const other = rules(data);
    if (other) return other;
    const value = data as Record<string, any>;
    if (!matchesSchema(name, data)) return 'schema';
    if (name === 'rating' && !(value.min < value.max && value.min <= value.rating && value.rating <= value.max)) {
        return 'rating-bounds';
    }
    if (name === 'paper' && !value.authors.includes(value.author)) return 'paper-authors';
    if ((name === 'grant' || name === 'grant-request') && value.expiresAt !== undefined && !isInstant(value.expiresAt)) {
        return 'expiry-instant';
    }
    return 'valid';
}

// Reads and edits a Compose .env file without disturbing it: comments, blank
// lines, ordering and settings node-runner does not know are kept as written,
// and only the value of a changed setting is rewritten.

export interface EnvLine {
    raw: string;
    key?: string;
    value?: string;
}

const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;
export const VALID_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Compose's .env value rules: single quotes are literal; double quotes allow
// backslash escapes; an unquoted value ends at a ` #` comment and is trimmed.
export function parseValue(rest: string): string {
    const text = rest.trim();
    if (text.startsWith("'")) {
        const end = text.indexOf("'", 1);
        return end > 0 ? text.slice(1, end) : text.slice(1);
    }
    if (text.startsWith('"')) {
        let out = '';
        for (let i = 1; i < text.length; i++) {
            const char = text[i];
            if (char === '"') {
                break;
            }
            if (char === '\\' && i + 1 < text.length) {
                const next = text[++i];
                out += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
                continue;
            }
            out += char;
        }
        return out;
    }
    const comment = text.search(/\s#/);
    return (comment >= 0 ? text.slice(0, comment) : text).trim();
}

export function parseEnv(text: string): EnvLine[] {
    const lines = text.split('\n');
    if (lines.at(-1) === '') {
        lines.pop();
    }
    return lines.map(raw => {
        const match = raw.match(ASSIGNMENT);
        return match && !raw.trimStart().startsWith('#') ? { raw, key: match[1], value: parseValue(match[2]) } : { raw };
    });
}

// The last assignment of a key wins, as it does for Compose.
export function envValues(lines: EnvLine[]): Map<string, string> {
    const values = new Map<string, string>();
    for (const line of lines) {
        if (line.key !== undefined) {
            values.set(line.key, line.value ?? '');
        }
    }
    return values;
}

// Unquoted when nothing in the value needs protecting; single-quoted (literal)
// otherwise. A value holding a single quote is double-quoted with escapes.
export function formatValue(value: string): string {
    if (/[\n\r]/.test(value)) {
        throw new Error('A setting cannot span several lines');
    }
    if (/^[A-Za-z0-9_./:,@%+=*-]*$/.test(value)) {
        return value;
    }
    if (!value.includes("'")) {
        return `'${value}'`;
    }
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$')}"`;
}

// Rewrites the last assignment of each changed key in place and appends keys
// the file does not have yet.
export function applyChanges(text: string, changes: Record<string, string>): string {
    const lines = parseEnv(text);
    const lastIndex = new Map<string, number>();
    lines.forEach((line, i) => {
        if (line.key !== undefined) {
            lastIndex.set(line.key, i);
        }
    });

    const appended: string[] = [];
    for (const [key, value] of Object.entries(changes)) {
        if (!VALID_KEY.test(key)) {
            throw new Error(`Not a valid setting name: ${key}`);
        }
        const formatted = `${key}=${formatValue(value)}`;
        const index = lastIndex.get(key);
        if (index === undefined) {
            appended.push(formatted);
        }
        else {
            lines[index] = { raw: formatted, key, value };
        }
    }

    const out = lines.map(line => line.raw);
    if (appended.length) {
        if (out.length && out.at(-1)!.trim() !== '') {
            out.push('');
        }
        out.push(...appended);
    }
    return out.join('\n') + '\n';
}

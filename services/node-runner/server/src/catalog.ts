// The catalog of settings, parsed from sample.env so there is one source of
// truth. In sample.env a comment line after a blank line names a section, the
// comment lines directly above a setting describe it, and a commented-out
// assignment (`# KEY=value`) is an optional setting with an example value.

export interface CatalogSetting {
    key: string;
    section: string;
    description: string;
    // The value sample.env sets, or '' for an optional, commented-out one.
    default: string;
    example?: string;
    secret: boolean;
}

export interface CatalogSection {
    name: string;
    settings: CatalogSetting[];
}

const SETTING = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
// One space at most after the `#`: deeper-indented assignments are examples
// inside prose, not optional settings.
const COMMENTED_SETTING = /^#\s?([A-Z_][A-Z0-9_]*)=(.*)$/;

// Settings shown write-only: their value is never sent back to the browser.
const SECRET = /(API_KEY|SECRET|PASSPHRASE|PASSWORD|_RUNE$|TOKEN|MNEMONIC|PRIVATE_KEY|MACAROON|SEED)/;

export function isSecret(key: string): boolean {
    return SECRET.test(key) && !/_(URL|FILE|PATH|NAME)$/.test(key);
}

// Settings the operator does not edit as plain values. Profiles have their own
// tab, and changing the project name would orphan every running container.
export const MANAGED_KEYS = new Set(['COMPOSE_PROFILES', 'COMPOSE_PROJECT_NAME']);

function exampleValue(raw: string): string {
    return raw.replace(/\s+#.*$/, '').trim().replace(/^(['"])(.*)\1$/, '$2');
}

export function parseCatalog(sample: string): CatalogSection[] {
    const sections: CatalogSection[] = [];
    const seen = new Set<string>();
    let section: CatalogSection | null = null;
    let comments: string[] = [];
    let afterBlank = true;

    const add = (key: string, value: string, optional: boolean) => {
        if (seen.has(key) || MANAGED_KEYS.has(key)) {
            comments = [];
            return;
        }
        if (!section) {
            section = { name: 'General', settings: [] };
            sections.push(section);
        }
        seen.add(key);
        section.settings.push({
            key,
            section: section.name,
            description: comments.join(' ').replace(/\s+/g, ' ').trim(),
            default: optional ? '' : exampleValue(value),
            ...(optional ? { example: exampleValue(value) } : {}),
            secret: isSecret(key),
        });
        comments = [];
    };

    for (const raw of sample.split('\n')) {
        const line = raw.trim();
        if (!line) {
            afterBlank = true;
            comments = [];
            continue;
        }
        const setting = line.match(SETTING);
        if (setting) {
            add(setting[1], setting[2], false);
            afterBlank = false;
            continue;
        }
        const commented = line.match(COMMENTED_SETTING);
        if (commented) {
            add(commented[1], commented[2], true);
            afterBlank = false;
            continue;
        }
        if (line.startsWith('#')) {
            const text = line.replace(/^#+\s?/, '');
            if (afterBlank) {
                // A heading line can run on into prose: the name ends at a
                // parenthesis, a dash or a sentence break.
                const cut = text.search(/\s\(|\s[—-]\s|\.\s/);
                const name = (cut > 0 ? text.slice(0, cut) : text).replace(/\.$/, '').trim();
                section = { name: name || 'General', settings: [] };
                sections.push(section);
            }
            else {
                comments.push(text);
            }
            afterBlank = false;
        }
    }

    // A section heading can recur further down; keep one section per name, at
    // its first position.
    const merged = new Map<string, CatalogSection>();
    for (const s of sections) {
        const existing = merged.get(s.name);
        if (existing) {
            existing.settings.push(...s.settings.map(setting => ({ ...setting, section: existing.name })));
        }
        else {
            merged.set(s.name, s);
        }
    }
    return [...merged.values()].filter(s => s.settings.length > 0);
}

import { readFileSync, globSync } from 'fs';

// The archon-noderunner skill tells an agent which settings to write into a
// node's .env. A setting no Compose file reads does nothing, so a renamed or
// removed setting would leave the skill configuring a node that silently
// ignores it (#1581).

const SKILL = 'deploy/claude-skill/archon-noderunner';
const COMPOSE = globSync('docker/compose/*.yml').concat(globSync('docker-compose*.yml'));

// Read by the skill's own scripts rather than by Archon.
const INSTALLER_ONLY = new Set(['ARCHON_HOSTNAME', 'ARCHON_ADMIN_EMAIL']);

const SETTING = /\b(?:ARCHON|GRAFANA)_[A-Z0-9_]*[A-Z0-9]\b/g;

function settingsIn(paths: string[]): Map<string, string[]> {
    const found = new Map<string, string[]>();
    for (const path of paths) {
        for (const [name] of readFileSync(path, 'utf-8').matchAll(SETTING)) {
            found.set(name, [...(found.get(name) ?? []), path]);
        }
    }
    return found;
}

describe('archon-noderunner skill settings', () => {
    const skill = settingsIn(globSync(`${SKILL}/**/*.{md,template,sh}`));
    const compose = COMPOSE.map(path => readFileSync(path, 'utf-8')).join('\n');

    it('finds the settings it is meant to check', () => {
        expect(skill.has('ARCHON_ADMIN_API_KEY')).toBe(true);
        expect(skill.has('ARCHON_HERALD_SESSION_SECRET')).toBe(true);
    });

    it('names only settings a Compose file reads', () => {
        const unread = [...skill.entries()]
            .filter(([name]) => !INSTALLER_ONLY.has(name) && !compose.includes(`\${${name}`))
            .map(([name, paths]) => `${name} (${[...new Set(paths)].join(', ')})`);

        expect(unread).toEqual([]);
    });

    it('fills every setting Gatekeeper and Keymaster require in the stage-0 template', () => {
        const template = readFileSync(`${SKILL}/templates/env.stage0.template`, 'utf-8');

        for (const name of ['ARCHON_UID', 'ARCHON_GID', 'ARCHON_ADMIN_API_KEY', 'ARCHON_PASSPHRASE', 'ARCHON_NODE_ID']) {
            expect(template).toMatch(new RegExp(`^${name}=\\{\\{[A-Z_]+\\}\\}$`, 'm'));
        }
    });

    it('has no placeholder outside a setting, so the filled file passes the skill\'s `{{` check', () => {
        const template = readFileSync(`${SKILL}/templates/env.stage0.template`, 'utf-8');
        const filled = template.split('\n')
            .map(line => /^[A-Z0-9_]+=/.test(line) ? line.replace(/\{\{[A-Z_]+\}\}/g, 'x') : line)
            .join('\n');

        expect(filled).not.toContain('{{');
    });
});

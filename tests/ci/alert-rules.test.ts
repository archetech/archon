import { readFileSync } from 'fs';
import { load } from 'js-yaml';

// A rule naming a metric nothing exports never fires, and nothing reports that
// it never fires. Grafana treats a query with no series as healthy here, because
// a node running no chain mediator has none (#1534).

const ALERTING = 'observability/grafana/provisioning/alerting';
const RULES = `${ALERTING}/mediator-wallet-funds.yaml`;

const MEDIATORS: Record<string, string> = {
    satoshi: 'services/mediators/satoshi/src/satoshi-mediator.ts',
    zcash: 'services/mediators/zcash/src/zcash-mediator.ts',
    ethereum: 'services/mediators/ethereum/src/ethereum-mediator.ts',
    solana: 'services/mediators/solana/src/solana-mediator.ts',
};

function rule(): any {
    const groups = (load(readFileSync(RULES, 'utf-8')) as any).groups;
    expect(groups).toHaveLength(1);
    expect(groups[0].rules).toHaveLength(1);
    return groups[0].rules[0];
}

function ruleMetrics(): string[] {
    const query = rule().data.find((entry: any) => entry.datasourceUid === 'prometheus');
    return query.model.expr.match(/[a-z]+_wallet_[a-z_]+/g);
}

describe('mediator wallet funds alert', () => {
    it.each(Object.entries(MEDIATORS))('reads the gauge the %s mediator exports', (prefix, path) => {
        const source = readFileSync(path, 'utf-8');
        const metric = `${prefix}_wallet_insufficient_funds`;

        expect(ruleMetrics()).toContain(metric);
        expect(source).toContain(`name: '${metric}'`);
    });

    it.each(Object.entries(MEDIATORS))('has the %s mediator feed that gauge from every balance check', (prefix, path) => {
        const source = readFileSync(path, 'utf-8');

        expect(source).toContain(`insufficientFunds: ${prefix}WalletInsufficientFunds`);
        expect(source).toContain(`unreachable: ${prefix}WalletUnreachable`);
        // The export pass, and startup so a restart does not clear a firing alert.
        expect(source.match(/await readFunding\(\)/g)).toHaveLength(2);
        expect(source).not.toMatch(/= await walletGetBalance\(\)/);
    });

    it('reads no metric beyond the mediators', () => {
        const known = Object.keys(MEDIATORS).map(prefix => `${prefix}_wallet_insufficient_funds`);

        expect(ruleMetrics().sort()).toEqual(known.sort());
    });

    it('stays quiet on a node running no chain mediator', () => {
        expect(rule().noDataState).toBe('OK');
    });
});

describe('alert delivery', () => {
    const quiet = () => load(readFileSync(`${ALERTING}/delivery.yaml`, 'utf-8')) as any;
    const email = () => load(readFileSync('observability/grafana/alert-email/delivery.yaml', 'utf-8')) as any;

    it('sends mail to the configured recipient, with nothing per-node in the repo', () => {
        const [contactPoint] = email().contactPoints;
        const [receiver] = contactPoint.receivers;

        expect(receiver.type).toBe('email');
        expect(receiver.settings.addresses).toBe('$ARCHON_ALERT_EMAIL_TO');
        expect(email().policies[0].receiver).toBe(contactPoint.name);
    });

    it('mutes the alert, rather than failing to mail it, with no recipient', () => {
        const route = quiet().policies[0].routes[0];
        const muting = quiet().muteTimes.map((entry: any) => entry.name);

        expect(route.object_matchers).toContainEqual(['archon_alert', '=', rule().labels.archon_alert]);
        expect(muting).toEqual(expect.arrayContaining(route.mute_time_intervals));
    });

    it('selects between the two files from the recipient setting alone', () => {
        const compose = readFileSync('docker/compose/observability.yml', 'utf-8');

        expect(compose).toMatch(/alerting\/\$\{ARCHON_ALERT_EMAIL_TO:\+\.\.\/\.\.\/alert-email\/\}delivery\.yaml:\/etc\/grafana\/provisioning\/alerting\/delivery\.yaml/);
        expect(compose).toMatch(/GF_SMTP_ENABLED=\$\{ARCHON_ALERT_EMAIL_TO:\+true\}/);
    });

    it('scrapes every mediator that can raise the alert', () => {
        const scraped = (load(readFileSync('observability/prometheus/prometheus.yml', 'utf-8')) as any)
            .scrape_configs.map((job: any) => job.job_name);

        for (const job of [
            'btc-mainnet-mediator', 'btc-signet-mediator', 'btc-t4-mediator', 'btc-t4-hosted-mediator',
            'zcash-mainnet-mediator', 'eth-mainnet-mediator', 'eth-sepolia-mediator',
            'sol-mainnet-mediator', 'sol-devnet-mediator',
        ]) {
            expect(scraped).toContain(job);
        }
    });
});

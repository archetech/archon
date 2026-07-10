import swaggerJsdoc from 'swagger-jsdoc';
import fs from 'fs';

const baseDefinition = {
    openapi: '3.0.0',
    info: {
        title: 'Keymaster API',
        version: '0.11.0',
        description: 'Documentation for Keymaster API'
    },
};

const gatekeeperOptions = {
    failOnErrors: true,
    definition: {
        ...baseDefinition,
        info: {
            ...baseDefinition.info,
            title: 'Gatekeeper API'
        }
    },
    apis: [
        'services/gatekeeper/server/src/gatekeeper-api.ts',
        'services/gatekeeper/server/src/v1-health-router.ts',
        'services/gatekeeper/server/src/v1-did-router.ts',
        'services/gatekeeper/server/src/v1-sync-router.ts',
        'services/gatekeeper/server/src/v1-ipfs-router.ts',
        'services/gatekeeper/server/src/v1-block-router.ts',
        'services/gatekeeper/server/src/v1-search-router.ts',
        'services/gatekeeper/server/src/identifiers-router.ts'
    ]
};

const keymasterOptions = {
    failOnErrors: true,
    definition: {
        ...baseDefinition,
        info: {
            ...baseDefinition.info,
            title: 'Keymaster API'
        }
    },
    apis: [
        'services/keymaster/server/src/keymaster-api.ts',
        'services/keymaster/server/src/keymaster-public-router.ts',
        'services/keymaster/server/src/keymaster-core-router.ts',
        'services/keymaster/server/src/keymaster-identity-router.ts',
        'services/keymaster/server/src/keymaster-address-router.ts',
        'services/keymaster/server/src/keymaster-didcomm-router.ts',
        'services/keymaster/server/src/keymaster-nostr-router.ts',
        'services/keymaster/server/src/keymaster-lightning-router.ts',
        'services/keymaster/server/src/keymaster-challenge-router.ts',
        'services/keymaster/server/src/keymaster-response-router.ts',
        'services/keymaster/server/src/keymaster-group-router.ts',
        'services/keymaster/server/src/keymaster-schema-router.ts',
        'services/keymaster/server/src/keymaster-agent-router.ts',
        'services/keymaster/server/src/keymaster-credential-workflow-router.ts',
        'services/keymaster/server/src/keymaster-key-router.ts',
        'services/keymaster/server/src/keymaster-schema-template-router.ts',
        'services/keymaster/server/src/keymaster-asset-router.ts',
        'services/keymaster/server/src/keymaster-poll-router.ts',
        'services/keymaster/server/src/keymaster-image-router.ts',
        'services/keymaster/server/src/keymaster-file-router.ts',
        'services/keymaster/server/src/keymaster-vault-router.ts',
        'services/keymaster/server/src/keymaster-dmail-router.ts',
        'services/keymaster/server/src/keymaster-notice-router.ts'
    ]
};

const gatekeeperSpec = swaggerJsdoc(gatekeeperOptions);
const keymasterSpec = swaggerJsdoc(keymasterOptions);
fs.writeFileSync('docs/gatekeeper-api.json', JSON.stringify(gatekeeperSpec, null, 2));
fs.writeFileSync('docs/keymaster-api.json', JSON.stringify(keymasterSpec, null, 2));

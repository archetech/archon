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
    apis: ['services/keymaster/server/src/keymaster-api.ts']
};

const gatekeeperSpec = swaggerJsdoc(gatekeeperOptions);
const keymasterSpec = swaggerJsdoc(keymasterOptions);
fs.writeFileSync('docs/gatekeeper-api.json', JSON.stringify(gatekeeperSpec, null, 2));
fs.writeFileSync('docs/keymaster-api.json', JSON.stringify(keymasterSpec, null, 2));

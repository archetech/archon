# @didcid/clients

Lightweight HTTP clients for Archon Gatekeeper, Drawbridge, and Keymaster services.
This package depends only on Axios and the browser-compatible Buffer package; it
does not install the Gatekeeper, Keymaster, IPFS, Helia, or libp2p runtimes.

```bash
npm install @didcid/clients
```

```ts
import GatekeeperClient from '@didcid/clients/gatekeeper';
import DrawbridgeClient from '@didcid/clients/drawbridge';
import KeymasterClient from '@didcid/clients/keymaster';
```

The service contracts and wire types are exported by the corresponding client
entry points. Type-only entry points are also available as
`@didcid/clients/gatekeeper-types` and `@didcid/clients/keymaster-types`.

The legacy `@didcid/gatekeeper/client`, `@didcid/gatekeeper/drawbridge`, and
`@didcid/keymaster/client` entry points remain as compatibility re-exports.

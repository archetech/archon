# Generic Pinning Mediator

The pinning mediator drains Gatekeeper's generic `pin` queue and asks a
configured IPFS Pinning Service API provider to retain each operation CID.

This is an auxiliary availability service only. It does not make the provider a
canonical DID registry and does not alter operation registration metadata.

Required configuration:

```env
ARCHON_PIN_API_TOKEN=provider-token
```

Common provider endpoints:

- Filebase: `https://api.filebase.io/v1/ipfs`
- Pinata: `https://api.pinata.cloud/psa`

Optional known IPFS origins can be supplied with `ARCHON_PIN_ORIGINS` as a
comma-separated list of multiaddrs.

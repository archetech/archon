# Filecoin Storage Mediator

The Filecoin mediator drains the auxiliary `pin` Gatekeeper queue and asks
the Filecoin wallet service to store each queued operation CID on Filecoin.

The mediator self-registers by polling the `pin` queue. This does not make
Filecoin a canonical DID registry; operations keep their original registries and
are copied to Filecoin only for storage durability.

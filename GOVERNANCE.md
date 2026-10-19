# Governance

Archon is a project under the jurisdiction of the [Archonomicon](https://github.com/archetech/archonomicon), the Archetech Nomicon ([rule 21](https://github.com/archetech/archonomicon#jurisdiction)). The rules of the game are the text of the Archonomicon's default branch (rule 9). This file only points to them. Where it seems to differ from them, the rules prevail (rule 24). Rules are cited by their permanent numbers (rule 26).

## What it means for this repository

**Ordinary changes.** Code, documentation, tests and tooling change through this repository's own process, described in [CONTRIBUTING.md](CONTRIBUTING.md). Those changes are not rule changes, but they must comply with the rules (rule 23). Project guidelines kept in this repository must not conflict with the rules (rule 24).

**The protocol is defined elsewhere.** The `did:cid` protocol is defined by the [did:cid Method Specification](https://archetech.com/didcid-specs/) ([source](https://github.com/archetech/didcid-specs)), and every implementation in this repository must conform to it (rule 42). Archon's own descriptions of the protocol, such as [the DID scheme](docs/scheme.md), [the white paper](docs/WHITEPAPER.md) and the [service specifications](docs/services/README.md), are informative.

**Differences are defects.** A difference between an implementation and the specification, or between two implementations, is corrected in the implementation, unless the specification is silent or in error, in which case the specification is corrected first (rule 43). Behaviour that affects which operations are accepted or how a DID resolves, and that the specification does not describe, must be specified with a test vector or removed (rule 44).

**Protocol changes.** A change to the protocol is made by changing the specification (rule 45):

- It is *Proposed* once the specification describes it, and signed test vectors for it, published in a project under jurisdiction and referenced by the specification, pass in every implementation that accepts operations or resolves DIDs.
- No implementation here may release it before it is Proposed.
- It is *Deployed* once every such implementation has released it and run it on the live network without diverging.

A protocol change must not change the result of any history the network has accepted, and the specification records the evidence for that (rule 46). Correcting an implementation to match the specification is not a protocol change unless it alters an accepted history (rule 47). Formally proved properties, such as `protocol_convergence` in [`proofs/`](proofs/), are stated in the specification, and a change affecting them is not Proposed until the proofs still check (rules 48 and 49).

**Security.** Report vulnerabilities privately, as [SECURITY.md](SECURITY.md) describes (rule 52). Rules 53 to 56 cover emergency fixes.

## Who decides

Anyone may submit a proposal: a pull request to the [Archonomicon repository](https://github.com/archetech/archonomicon) that adds, amends or repeals rules (rules 10 and 11). The players and the Operator are listed in [players.md](https://github.com/archetech/archonomicon/blob/master/players.md), and the rules say how proposals are agreed, objected to and adopted (rules 12 to 16, 37 and 38).

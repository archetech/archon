# Archon and User-Owned Digital Actors

The next wave of software will not be made only of human users logging into
apps. It will include AI agents, services, devices, organizations, and other
digital actors that need to act, receive instructions, hold permissions,
exchange private messages, prove credentials, and recover state over time.

Most of today's infrastructure treats these actors as app-owned accounts,
API keys, or temporary sessions. That works when the actor lives inside one
product. It becomes fragile when the actor needs to operate across tools,
teams, organizations, or networks. The account, permissions, messages, and
history are trapped wherever they were created.

Archon approaches the problem from the opposite direction: start with an
identity and wallet that the actor controls, then let applications attach to
that identity. An Archon actor can have a DID, cryptographic keys, encrypted
messages, verifiable credentials, assets, groups, vaults, names, and payment
hooks. The account is not just a login record in one database; it is a
portable identity container that can be resolved and verified by compatible
nodes.

The near-term wedge is AI agents. As agents begin to perform real work for
people and organizations, they need more than prompts and API tokens. They
need durable identities, proof of who controls them, scoped credentials,
private delivery channels, revocation, recovery, and a way to participate in
payment or access-control flows. Archon already contains many of these
building blocks in one self-sovereign stack.

The broader category is account infrastructure for digital actors. Archon is
not trying to make every application live inside one hosted platform. It is a
reference implementation of `did:cid`, an emerging open DID method in the DIF
standardization pipeline, plus a working wallet, resolver, credential,
messaging, naming, and registry architecture around it. That distinction
matters: the goal is not to own the namespace, but to make identities and
their associated state usable across compatible software.

The elevator pitch follows from that:

> Archon gives digital actors user-owned accounts: a DID, wallet, encrypted
> inbox, credentials, and portable state for people, services, devices, and AI
> agents, built on the emerging `did:cid` standard.

For investors, developers, and early customers, the important claim is not
that Archon has solved universal interoperability overnight. The important
claim is that Archon makes a different kind of account possible: one where
identity, authority, and relationships are controlled by the actor's owner
rather than by the application that first created the account.

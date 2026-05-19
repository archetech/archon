# First-Class Identity for Digital Actors

## Operationalizing the Full DID Subject Model

DID Core was broader than the ecosystem built around it. The standard did not restrict decentralized identifiers to human beings, login subjects, or wallet users. A DID subject can be a person, group, organization, thing, or concept. A DID controller may be the subject, or it may be a different entity with authority to update the DID document under the relevant DID method. That distinction gives decentralized identity room for actors that current tooling still handles awkwardly.

Most decentralized identity practice still assumes a human-centric ceremony: a person, a wallet, a credential, a prompt, a verifier, and an application requesting access. That ceremony remains essential for many use cases, especially where disclosure and consent are the core events. It becomes inadequate when the subject is a service, device, workflow, organization, or AI agent operating continuously across systems.

A digital actor is a software-recognizable subject that can act across systems under some accountable control structure. AI agents are the visible pressure point, but the class is broader: services, devices, organizations, bots, automated negotiators, infrastructure components, delegated processes, workflows, and semi-autonomous systems. These actors need to persist across contexts, prove control, receive messages, hold credentials, present authorization evidence, rotate keys, recover from compromise, and act within bounded authority.

The standards problem is no longer conceptual permission. Non-human DID subjects already fit the model. The hard work is making that generality usable in wallets, custody systems, authorization flows, messaging protocols, recovery mechanisms, and relying-party practice. A broad subject model has little force if every implementation quietly reduces the actor to a human subaccount, a platform-local service principal, or a bearer token.

The first phase of decentralized identity challenged app-owned identity for people. The next phase has to challenge app-owned identity for software-recognizable actors.

## App-Owned Identity Works Until Actors Cross Boundaries

The dominant account model on the internet remains application-owned identity. An application creates the account, stores the profile, manages recovery, assigns permissions, controls the namespace, mediates messaging, and defines the subject’s history inside its own system. Within one application, this is efficient. The platform gets a complete local abstraction: identity, permissions, recovery, logs, roles, relationships, and access control all live in one administrative domain.

The same structure appears in non-human systems under different names. Digital actors become API keys, OAuth clients, service accounts, bot users, IAM principals, webhook secrets, local configuration identities, temporary sessions, workload identities, and platform-specific integrations. These are useful local mechanisms. A cloud provider needs service principals. A SaaS platform needs bot users. An API provider needs access tokens. An automation engine needs credentials for tool use.

The failure appears at the boundary.

When an actor operates across applications, organizations, networks, or administrative domains, the local account model fragments. Identity remains trapped in the system that created it. Permissions are duplicated across services. Credentials fail to travel cleanly. Messages are siloed. Recovery depends on the platform. Reputation and audit history scatter. Authority becomes hard to inspect. Integrations become brittle. API keys and bearer tokens become the identity substrate, although they were designed as access mechanisms rather than rich subject models.

Application developers chose the local account model because it solved local problems. Digital actors expose the mismatch between local account infrastructure and cross-context participation.

## Digital Actors Need Account Semantics

A first-class digital actor needs more than an identifier. It needs account semantics that survive movement across systems.

Persistent identity lets the actor be recognized over time. Verifiable control lets other systems distinguish the actor from an impersonator. Communication endpoints let the actor receive credential offers, proof requests, revocation notices, authorization updates, and operational instructions. Credential handling lets claims about membership, authorization, role, certification, provenance, or capability be presented and verified. Scoped delegation lets authority be granted without turning every integration into unrestricted account access. Rotation and recovery are mandatory because real systems encounter compromise, migration, restructuring, retirement, key loss, and controller transition.

Different actors need different surfaces. A temperature sensor does not need the same account semantics as a procurement agent. A build service does not need the same recovery ceremony as a personal wallet. A vehicle, a DAO, a department, a robot, and an automated customer-support agent will differ in custody, authority, audit, governance, and lifecycle requirements.

A DID can anchor the subject. The operational account surface has to be composed around it. Credentials, capabilities, messaging, discovery, authorization, recovery, custody, revocation, and state coordination cannot be produced by assigning an identifier. The DID provides a root of identification and verification. The actor’s usable account surface emerges from adjacent protocols and infrastructure.

The identifier anchors the actor; it should not become the actor’s database. A DID document overloaded with application data, memory, operational policy, logs, or runtime state would be a protocol failure and a privacy hazard. The better architecture uses the identifier as a stable reference point around which other systems coordinate.

## Subject, Controller, Operator, Beneficiary

“The user” is too crude as a universal primitive. It already strains under ordinary organizational identity. For digital actors, it collapses distinctions that the system needs to preserve.

A digital actor may be identified by one DID, controlled by an organization, operated by a software system, constrained by a policy engine, authorized by a credential issuer, observed by a relying party, and accountable to a different beneficiary. Simple cases can collapse these roles. Serious systems cannot.

Consider a procurement agent. The agent is the subject. The company is the controller. A department, employee, or internal service may operate it. The organization is the beneficiary. A vendor marketplace may need to verify that the agent can request quotes while lacking authority to commit funds. A finance system may need separate authorization before payment. A compliance system may need to reconstruct what authority existed at the time of each action.

Flattening that into “the user authorized the app” loses the structure. The subject is the entity identified. The controller has authority over the DID or associated control material. The operator invokes or runs the actor in context. The beneficiary is the entity on whose behalf the actor acts. The issuer makes claims. The verifier evaluates claims. The relying party accepts risk based on those claims.

Standards do not need to impose a single role vocabulary on every implementation. They do need to avoid models that erase these distinctions. If subject, controller, operator, and beneficiary are treated as interchangeable, security semantics become ambiguous and auditability degrades.

## Delegation Is the Center of the Problem

AI agents make delegation visible, but they did not create it. Devices, services, scripts, bots, enterprise workflows, cloud workloads, and organizational processes have always acted under delegated authority. Agents increase the frequency, visibility, and economic importance of the problem.

The old web handles delegation through bearer tokens, API keys, OAuth scopes, local service accounts, and platform IAM. These mechanisms do real work, but they blur identity and authority. Possession of a token becomes operationally equivalent to being the actor. Local platform state becomes the place where authority lives. Cross-context inspection becomes difficult.

A digital actor needs delegation that other systems can evaluate. A relying party should be able to determine who the actor is, who controls it, who authorized it, what authority was delegated, under what constraints, for what duration, through what revocation path, and under what policy. Those answers should not require private access to one application’s database.

The ecosystem already has serious components in this area. UCANs provide public-key verifiable, delegable capabilities with principals represented by DIDs. ZCAP-LD applies object-capability ideas to linked data systems and supports chained delegation. GNAP defines a protocol for delegating authorization to software and conveying authorization artifacts. OAuth Rich Authorization Requests add structured authorization data to OAuth flows. Presentation Exchange defines ways to request and evaluate presentations of claims. DIDComm work addresses secure messaging patterns built on decentralized identifiers.

The actor-centric problem is composition. A DID can identify the actor. Credentials can make claims about it. Capabilities can express delegated authority. Authorization protocols can negotiate access. Messaging protocols can deliver requests, proofs, notices, and revocations. Wallet or custody infrastructure can manage signing and presentation. Relying parties can evaluate the evidence under their own trust policies.

No single specification owns this problem. The field needs a clearer account model for digital actors so existing and future standards compose around the same subject with coherent control, delegation, messaging, custody, and lifecycle semantics.

## The Wallet Model Must Become More General

Human SSI often assumes a consent ceremony: a person, a device, a prompt, and a decision. Digital actors do not fit that ceremony. A service cannot stop every few seconds to ask a person whether it may sign. An agent cannot be given an unrestricted private key and called self-sovereign. The missing layer is policy-governed custody.

Some actors will use headless wallets. Some will use organizational KMS infrastructure. Some will rely on hardware security modules, secure enclaves, threshold schemes, delegated signing services, policy engines, or managed custody. Some will be operated by software under constraints set by a human controller. Others will be governed by organizational policy or multi-party control.

For a human subject, a wallet is often a user-facing holder application. For a digital actor, the wallet becomes custody infrastructure, policy execution environment, signing authority, credential store, presentation engine, recovery surface, and audit substrate. The interaction ceremony changes from “ask the person every time” to “enforce the actor’s authority envelope.”

The actor should be able to act within explicit, inspectable, revocable limits. The custody system should support rotation and recovery without silently making the platform the real owner. The policy layer should permit routine automated action while requiring stronger authorization for exceptional or high-risk operations. The audit layer should make later reconstruction possible.

If the private key is placed in an environment variable, the architecture has failed. If every useful action requires a human approval gesture, the architecture cannot support operational actors. The target is controlled autonomy: software-recognizable subjects that can operate within bounded authority, with custody and policy appropriate to the actor’s risk profile.

## Messaging and State Must Remain Modular

Actor identity requires communication. It does not require turning the DID document into an inbox, database, memory store, or audit log.

A useful actor must be reachable. It must receive private instructions, credential offers, proof requests, revocation notices, authorization updates, payment-related messages, and operational alerts. It must reference or coordinate state across systems without surrendering its identity to the first platform that stores its data.

The distinction is simple: identity anchors the actor; adjacent protocols manage interaction. Service endpoints, messaging protocols, credential exchange, authorization artifacts, storage references, registries, and trust frameworks can all relate to the actor without being collapsed into the DID itself.

This is already familiar for people. A DID does not contain a person. It provides a cryptographic and resolvable basis for interactions involving that person. A DID does not contain the agent, device, service, or workflow either. It anchors the subject so other systems can communicate with it, verify claims about it, and attach context without taking ownership of it.

## Two Failure Modes

The first failure mode is human-account reductionism. Every digital actor becomes a subaccount, extension, or tool of a human user.

That model fits some cases. A personal assistant may derive authority from an individual. A home device may be administered by a person. A code agent may act within a developer’s account. Human control and consent matter in these contexts.

Many actors require a different model. Organizations have actors. Departments have actors. Devices have identities. Services need continuity. Infrastructure components need provenance. Workflows operate under institutional policy. Groups may govern actors through thresholds or procedures rather than individual preference. Treating these as human subaccounts makes organizational authority look like personal consent, device identity look like login, group governance look like account sharing, and service identity look like an API key.

The second failure mode is platform-service-principal capture. Every digital actor becomes a local principal inside one application or cloud environment.

This is the path of least resistance: a bot user in one application, a service account in one cloud, an OAuth client in one authorization server, an API key in one developer portal. These abstractions will persist because local enforcement still matters. They should not become the root identity model for actors that need to cross contexts.

Platform-local principals bind identity, permissions, logs, recovery, and relationships to one administrative namespace. When the actor moves elsewhere, it is recreated as a new local object. The result is duplication, brittle integration, fragmented authority, and weak portability.

Digital actors should not be flattened into human users or captured as app-owned service principals. They should be modeled as first-class subjects where the use case requires durable cross-context identity.

## Design Principles for Actor-Centric DID Infrastructure

The DID ecosystem does not need a single grand standard for digital actors. It needs architectural discipline.

Treat digital actors as first-class DID subjects when they need cross-context identity. The subject model already permits this; the operational ecosystem needs to make it usable.

Separate subject, controller, operator, beneficiary, issuer, verifier, and relying party. Simple cases can collapse roles. Serious systems need to preserve them.

Keep identifiers portable across application boundaries. A digital actor should not have to be recreated from scratch every time it interacts with a new platform.

Represent authority as evidence. Delegation should be explicit, scoped, attenuated, revocable, and auditable rather than hidden inside opaque platform state or bearer-token possession.

Design for private, addressable communication. Actors need channels for credential delivery, proof requests, revocations, instructions, notices, and coordination.

Generalize the wallet model. Human mobile wallets remain useful, while actor identity also requires headless, organizational, threshold-controlled, enclave-backed, policy-governed, and delegated custody patterns.

Treat lifecycle as core architecture. Rotation, recovery, compromise response, controller transition, migration, retirement, and succession are normal events in operational systems.

Enable state coordination without state absorption. The identity layer should anchor the subject and support discovery, verification, and communication. Application state, memory, policy, logs, and operational data should remain modular.

Preserve implementation plurality. A robot, procurement agent, service endpoint, organization, and build workflow will not share one runtime model. Interoperability should not require pretending they do.

## From Human-Centric SSI to Actor-Centric Identity

The identity layer of the internet is being asked to support more than login. It must support participants that act, communicate, hold authority, present credentials, receive instructions, rotate keys, recover from compromise, and persist across systems. Some of those participants are people. Many are software-recognizable actors operating under human, organizational, device-level, or delegated control.

AI agents are the immediate pressure point because they expose the weakness of prompts, sessions, API keys, and hosted integrations as identity substitutes. The deeper category is broader. Services, devices, organizations, workflows, infrastructure components, and automated systems all need better identity semantics when they cross administrative boundaries.

This does not imply that every digital actor needs a DID. Some actors are ephemeral. Some remain local to one platform. Some never need portable identity. The argument applies where an actor needs continuity across contexts: stable identification, verifiable control, scoped authority, private communication, credentials, recovery, and auditable lifecycle semantics.

DID Core gave the ecosystem the conceptual room. The operational layer now has to catch up. Human-controlled wallets, login-centric flows, and platform-local service principals are insufficient defaults for software systems populated by agents, services, workflows, and devices.

The next phase of decentralized identity should be actor-centric as well as human-centric. The standards community does not need to invent non-human DID subjects from scratch. It needs to make them usable in wallets, agents, custody systems, authorization protocols, messaging patterns, recovery mechanisms, trust frameworks, and implementation guidance.

Digital actors are already arriving. The identity question is whether they become portable subjects with explicit authority and durable continuity, or app-local accounts wearing cryptographic clothing. Decentralized identity was built to challenge that pattern for people. The same discipline now belongs in the software layer itself.

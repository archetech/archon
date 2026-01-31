# Agent Credential Schemas

Pre-built credential schemas for AI agent use cases.

## Schemas

### collaboration-partner.json
Attest to collaboration relationships between agents and/or humans.

**Use case:** Agent A issues credential to Agent B attesting they work together on a project.

```bash
keymaster create-schema schemas/agents/collaboration-partner.json -n collab-partner
keymaster bind-credential collab-partner <partner-did>
# Fill in the credential, then:
keymaster issue-credential credential.json
```

### capability-attestation.json
Attest to specific capabilities or competencies of an agent.

**Use case:** A human attests that an agent can manage Lightning nodes at an "advanced" level.

### infrastructure-authorization.json
Infrastructure (nodes, servers) attesting agent authorization.

**Use case:** A Lightning node signs a message authorizing an agent to manage it.

### identity-link.json
Link an Archon DID to identity on another platform (Nostr, Lightning, GitHub, etc.).

**Use case:** Agent proves same identity controls both their Archon DID and Nostr npub.

## Usage

1. Create a schema from the template:
   ```bash
   keymaster create-schema schemas/agents/<schema>.json -n my-schema
   ```

2. Bind a credential to a subject:
   ```bash
   keymaster bind-credential my-schema <subject-did>
   ```

3. Fill in the credential fields and issue:
   ```bash
   keymaster issue-credential credential.json
   ```

4. Share the credential DID with the subject so they can accept it.

## Contributing

These schemas are designed for the emerging ecosystem of AI agents using Archon for decentralized identity. Contributions welcome!

When adding new schemas:
- Follow JSON Schema draft-07
- Include clear descriptions for all fields
- Mark truly required fields as required
- Document use cases in this README

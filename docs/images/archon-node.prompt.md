# Archon node diagram

The root `archon-node.png` is a high-level overview for the README. Updated using the built-in image generation tool, with the prior image as a style reference. Topology checked against `docker-compose.yml` and `docker/compose/` on 2026-09-18.

Maintenance: verify generated arrow directions against service configuration. Use explicit dependency captions for grouped services when connectors become ambiguous. This overview does not enumerate every container or client-side storage dependency.

## Initial edit prompt

Edit the provided Archon node architecture image into an accurate refreshed README diagram. Preserve its dark navy background, restrained glowing cyan/teal/purple circuit-board style, cloud network symbols, rectangular service cards and cylindrical databases. Improve legibility substantially: large crisp sans-serif labels, ample spacing, clean straight orthogonal connectors, no tiny decorative text. Wide landscape high-resolution composition. Title: "Archon node". Subtitle: "Core identity services and optional integrations". This is a high-level architecture overview, not an exhaustive container map.

Use precisely this topology with arrowheads meaning "uses", not data flow:
TOP row 3 client groups:
"Wallet apps" subtitle "React wallet · Browser extension" arrow to Gatekeeper.
"Explorer · Admin CLI" arrow to Gatekeeper.
"Keymaster client · Archon CLI" arrow to Keymaster.

CENTER large core row:
"Gatekeeper" subtitle "TypeScript or Rust" and small text "DID validation · History replay".
"Keymaster" subtitle "TypeScript or Python" small text "Keys · Signing · Wallet operations".
Keymaster arrow to Gatekeeper.
Under Gatekeeper two storage symbols: "DID database" and "IPFS node"; Gatekeeper arrow to each.
Under Keymaster a cylinder "Wallet database"; Keymaster arrow to it.
Next to IPFS node a cloud "IPFS network"; connect IPFS node to cloud.

LOWER row two spacious integration groups, dotted borders with section heading "Optional mediators":
Left card "Hyperswarm mediator", arrows upward to Gatekeeper and Keymaster, separate cloud "Hyperswarm peers" linked to this mediator. Small annotation in this group "Operation gossip · Proof-time events".
Right card "Chain mediators", arrows upward to Gatekeeper and Keymaster. Below card "Chain RPCs / wallets" linked from Chain mediators, then four network cloud badges "Bitcoin", "Zcash", "Ethereum", "Solana" connected from Chain RPCs / wallets. Small footer within this group "Mainnet and supported test networks".

Bottom broad quiet panel labeled "Other optional services" with two text rows, no dependency arrows for this summary panel:
"Drawbridge · Herald · DIDComm · Lightning"
"IPFS pinning · Filecoin storage · Prometheus / Grafana"
Footer legend: "Arrow = uses    •    Dashed group = optional"
Draw only the edges specified above. Arrange flexible positions and route connectors around all labels to avoid spaghetti; labels must be exact and legible. Do not include FTC or FTC:testnet5, network port numbers, invented services, or consensus/finality promises. No clip art logos or watermark. Keep architecture precise while preserving the original visual identity.

## Correction prompt

Edit this architecture diagram with ONLY these corrections, preserving all other labels, positions, style and graphics:
1. Remove ALL upward cyan cables between the two optional mediator panels and the core services. Specifically remove the two stalks from Hyperswarm mediator up to Gatekeeper, and the two stalks from Chain mediators up to Keymaster. Keep the Gatekeeper-to-database and Gatekeeper-to-IPFS downward arrows, Keymaster-to-wallet-database downward arrow, and Keymaster-to-Gatekeeper horizontal arrow untouched.
2. In the left dashed panel below its "Optional mediators" heading, add clear smaller text "Uses Gatekeeper · Keymaster · IPFS".
3. In the right dashed panel below its "Optional mediators" heading, add clear smaller text "Uses Gatekeeper · Keymaster".
These dependency captions replace the removed upward cables.
4. Reverse the arrow between Hyperswarm peers cloud and Hyperswarm mediator: it must point LEFT from mediator toward peers, consistent with Arrow = uses.
Keep all other content and all other connectors exactly unchanged. Do not draw any new upward mediator cables. Output the complete high-resolution image.

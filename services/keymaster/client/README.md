# Archon Keymaster WebUI Wallet

This directory contains the Archon Keymaster WebUI wallet app. This is a minimalistic reference implementation wallet that can be used as-is or as a basis for future Archon wallet development efforts.

## Accessing your Keymaster Web Wallet

A **private** Archon web wallet exposed by the server's Keymaster process on port [http://localhost:4226/](http://localhost:4226)

The Keymaster's Web Wallet on port 4226 exposes the server keys located in the Keymaster's configured database (data/wallet.json by default). This shares the same wallet as accessed by the ./archon command line interface client. **Port 4226 should never be exposed to the public as it exposes the server's keymaster wallet.**

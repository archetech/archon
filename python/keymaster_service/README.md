# Python Keymaster Service

Native Python implementation of the Archon Keymaster service.

This package is intended to run inside Docker and expose the same `/api/v1`
surface as the existing TypeScript service. The current implementation focuses
on the wallet and identity foundation needed for a drop-in port.
# Security

## Reporting a vulnerability

Report suspected vulnerabilities privately via [GitHub Security Advisories](https://github.com/archetech/archon/security/advisories/new). Please do not open a public issue for an unpatched vulnerability.

A past point-in-time review is kept in [SECURITY_AUDIT.md](SECURITY_AUDIT.md).

---

## Key generation and entropy

This section documents where Archon's private keys come from and how much entropy they carry. It exists because "the private key is 256 bits" is true of the *value* and misleading about the *entropy* — the two differ, and the difference is worth stating plainly.

Every claim below was verified against the code and by executing the relevant paths, not read off documentation.

### Wallet keys derive from a single 128-bit seed

```
bip39.generateMnemonic()          128 bits of entropy (12 words)
  ↓ mnemonicToSeedSync — PBKDF2-HMAC-SHA512, 2048 iterations
512-bit seed                      still 128 bits of entropy
  ↓ HDKey.fromMasterSeed → derive("m/44'/0'/{account}'/0/{index}")
32-byte secp256k1 private key     256-bit value, 128 bits of entropy
```

`packages/cipher/src/cipher-base.ts` calls `bip39.generateMnemonic()` with **no strength argument**; bip39 v3.1.0 defaults to `strength = 128`. The Python port states it explicitly — `python/keymaster/src/keymaster/crypto.py` uses `Mnemonic("english").generate(strength=128)` — so both implementations agree.

The PBKDF2 stretch to a 512-bit seed **adds no entropy**. Stretching increases the cost of a brute-force attempt per guess; it does not increase the number of guesses required.

### Why 128 bits is the right choice, not a shortfall

secp256k1 provides roughly **128-bit security** — Pollard's rho solves the discrete log on a 256-bit curve in about 2¹²⁸ operations. Seed entropy of 128 bits is therefore *matched to the curve*, not the limiting factor. Raising the mnemonic to 256 bits (24 words) would not make the resulting keys harder to attack; the curve still caps the attacker's work at ~2¹²⁸.

12 words is also the dominant default across BIP-39 wallets.

### The real consequence is correlation, not strength

Every identity in a wallet derives from one master seed, distinguished only by the `account` index in the derivation path. **Compromising the mnemonic compromises every DID derived from it**, across all accounts, retroactively and permanently.

This is inherent to hierarchical-deterministic wallets and is intended — it is what makes a single mnemonic a complete backup. It does mean the mnemonic is the entire security boundary for wallet-derived keys, and that separate mnemonics, not separate accounts, are what actually isolate identities.

### One seed phrase for the whole node

This is by design: a node has **one** mnemonic, and everything it controls derives from it. The wallet mediators hold no seed of their own — each fetches the Keymaster's over HTTP at startup and derives its chain keys from it:

```js
// services/mediators/*/src/wallet-api.ts
const response = await axios.get(`${config.keymasterURL}/api/v1/wallet/mnemonic`, { headers });
```

So the same 128-bit seed that produces your DIDs also produces the on-chain spending keys:

| service | derivation path | standard |
| --- | --- | --- |
| Identity / DID keys | `m/44'/0'/{account}'/0/{index}` | BIP-44 |
| DIDComm X25519 | `m/44'/0'/{account}'/1/0` | dedicated branch |
| Bitcoin (`satoshi-wallet`) | `m/84'/{0\|1}'/0'` | BIP-84 native segwit |
| Ethereum (`ethereum-wallet`) | `m/44'/60'/0'/0/0` | BIP-44 |
| Solana (`solana-wallet`) | `m/44'/501'/0'/0'` | ed25519-hd-key |
| Zcash (`zcash-wallet`) | `m/44'/{133\|1}'/0'/0/{i}` | BIP-44 transparent |
| Filecoin (`filecoin-wallet`) | `m/44'/461'/0'/0/0` | BIP-44 |

Chain paths are overridable per service (`ARCHON_WALLET_ETH_DERIVATION_PATH` and equivalents); the identity paths are not.

The benefit is the usual HD-wallet one, applied node-wide: twelve words back up the entire node — every DID, on every account, plus every chain wallet — and restoring them reconstructs all of it. There is no per-service key material to enumerate, escrow, or lose.

The cost is that the mnemonic is a **funds-bearing** secret, not only an identity secret. Compromising it does not merely expose every DID; it yields spending authority over every chain wallet the node operates. Treat it accordingly, and note that isolating funds from identities — or one identity from another — requires a **separate node with its own mnemonic**, not a separate account index.

Two operational consequences follow from the mediators fetching rather than holding the seed:

- **`GET /api/v1/wallet/mnemonic` returns the decrypted mnemonic.** It sits behind the admin-key middleware, but that middleware **passes the request through when `ARCHON_ADMIN_API_KEY` is unset** — a deliberate development-mode behaviour that the Keymaster warns about at startup (`Warning: ARCHON_ADMIN_API_KEY is not set — admin routes are unprotected`). On a node reachable beyond localhost without that variable set, the mnemonic is readable by anyone who can reach the port. Set it.
- **The plaintext mnemonic crosses the service boundary** on each fetch — at startup, and again on the metrics interval for backends that need it. Within a Docker network that is contained, but it means Keymaster's port is as sensitive as the wallet file itself, and exposing it beyond the compose network changes the threat model entirely.

### Nostr keys are the DID key in another format

`getNostrKeys` returns the imported `nsec` if one is present; otherwise it converts the identity's own secp256k1 keypair (`fetchKeyPair`) into nostr format. Absent an explicit import, **the nostr identity and the DID share one private key** — a compromise of either is a compromise of both, and rotating one rotates the other.

Lightning is different: the LNbits `invoiceKey` and `adminKey` are issued by that external service and stored in the wallet. They are not seed-derived and not recoverable from the mnemonic.

### Keys that do not derive from the seed

Two paths generate independent key material at full width:

| path | source | entropy |
| --- | --- | --- |
| Vault keypair (`generateRandomJwk`) | `secp.utils.randomPrivateKey()` → `randomBytes(48)` reduced per FIPS 186 B.4.1 | ~256 bits |
| Salts (`generateRandomSalt`) | `randomBytes(32)` / `getRandomValues(32)` | 256 bits |
| Passphrase salt / IV | `@noble/hashes` `randomBytes` | 128 / 96 bits |

A vault keypair is *not* recoverable from the mnemonic. That is a deliberate trade-off in the opposite direction from the wallet keys, and worth knowing before assuming a seed backup covers everything.

DIDComm X25519 keys **are** seed-derived: `generateX25519Jwk` takes 32 bytes of HD-derived material and uses it directly as the X25519 private scalar, so the same seed always yields the same key-agreement keypair.

### Randomness source

Every path reaches `crypto.getRandomValues`, but **through two independent implementations**, not one:

| generator | RNG | reached via |
| --- | --- | --- |
| Mnemonic, salts, passphrase IV | `@noble/hashes` `randomBytes` | `bip39.generateMnemonic()`, `generateRandomSalt()` |
| Vault keypair | `@noble/secp256k1`'s own `randomBytes` | `secp.utils.randomPrivateKey()` |

`@noble/secp256k1` does not use `@noble/hashes` for this — it ships its own. The two are separate packages on separate version lines, so **a dependency bump can change one and leave the other untouched**. (A single install can also contain more than one resolved copy of `@noble/hashes`; `@noble/curves` nests its own.) Anything asserting a property of "the RNG" has to assert it of both.

Both refuse to degrade, by different mechanisms:

```js
// @noble/hashes — captures globalThis.crypto at module load
throw new Error('crypto.getRandomValues must be defined');

// @noble/secp256k1 — reads globalThis.crypto at call time, then dereferences it
const cr = () => globalThis?.crypto;
```

There is no silent degradation to `Math.random()` on any path, in either the Node or browser build. This is the property most worth preserving — a weak-RNG regression is invisible in tests and catastrophic in production, so `tests/cipher/rng.test.ts` asserts it of both implementations, in both directions: that each draws from `crypto.getRandomValues`, and that each throws rather than returning anything when no CSPRNG exists.

Note what those tests deliberately do **not** do. A degraded RNG still produces output that looks random, so neither statistical testing nor any assertion about the shape of a generated mnemonic would catch a substitution. Only provenance and the absence of a fallback are worth asserting.

### Where the entropy ultimately comes from

`crypto.getRandomValues` is where Archon's responsibility ends, but it is not where the randomness originates. Below it, both implementations above converge on one chain — on a Linux node:

```
bip39.generateMnemonic() · randomPrivateKey() · generateRandomSalt()
  ↓ @noble/hashes randomBytes
crypto.getRandomValues                       Web Crypto
  ↓ Node routes this to OpenSSL RAND_bytes
OpenSSL 3.x CTR-DRBG (AES-256-CTR)           periodically reseeded
  ↓ seeded via the OS entropy syscall
getrandom(2)                                 BCryptGenRandom / getentropy elsewhere
  ↓
Linux kernel CSPRNG (ChaCha20)
  ↑ seeded and continuously reseeded from
interrupt timing jitter · RDSEED/RDRAND · bootloader/EFI seed · seed file across reboots
  ↑ which in turn originate in
thermal noise in silicon · timing variance between physically independent clocks
```

Note which branch actually runs: `@noble/hashes` tries `crypto.getRandomValues` first and only falls back to Node's `crypto.randomBytes` if it is absent. Since Node 19 exposes `globalThis.crypto`, **the first branch is the one taken** on every supported Node version and in browsers; the fallback is legacy compatibility that current deployments never reach.

#### The bottom of the chain is physics

Everything above is transport. A DRBG expands entropy, a seed file carries it across a reboot, `getrandom(2)` hands it over — none of them *create* any. Follow the inputs down and they terminate in two physical processes:

**Thermal noise in silicon.** `RDSEED` is backed by an on-die entropy source: a circuit deliberately driven into a metastable state, whose settling direction is decided by Johnson–Nyquist noise — the random thermal motion of charge carriers in the transistors. That raw output is biased, so the hardware conditions it (Intel's design runs it through AES-CBC-MAC) before `RDSEED` returns it. The randomness is manufactured by heat, not by an algorithm.

**Timing variance between independent physical systems.** The kernel timestamps hardware interrupts with the CPU cycle counter and mixes in the low bits. Those bits are unpredictable because the events and the clock measuring them are physically decoupled: a network packet's arrival is determined by events on another machine, a disk completion by mechanical and thermal conditions in the drive, and the sampling clock itself drifts against them through oscillator phase noise — which is, again, thermal. Related jitter-entropy designs measure variance in the CPU's own execution timing, arising from cache state, frequency scaling, and the same underlying noise.

So the honest answer to "where does the entropy ultimately come from" is: **thermal noise in physical hardware**, sampled either directly by a dedicated circuit or indirectly through timing. It bottoms out in statistical mechanics — and at the smallest scale, quantum effects — not in any part of the software stack.

Two caveats worth stating:

- **This host is a WSL2 VM with no `hw_random` device** (`rng_available` is `none`), so the kernel's hardware-RNG framework contributes nothing here. On such systems the arch-random path (`RDSEED` on this i7-14700F) and interrupt timing carry the load. A cloud VM typically also gets `virtio-rng`, which is the *host's* entropy passed through — it does not generate any, which is why a cloned guest is dangerous.
- **"Random" here means physically unpredictable, not provably indeterminate.** The security claim is that no attacker can model thermal fluctuations in your specific silicon well enough to predict the output — not a metaphysical claim about determinism.

Three consequences worth understanding:

**The CPU's hardware RNG is an input, not the source.** Linux mixes `RDSEED`/`RDRAND` into the pool rather than emitting them directly, so a backdoored CPU RNG cannot by itself determine what Archon gets. (With `random.trust_cpu`, which many distributions enable, that hardware output is additionally *credited* toward initial seeding — it still passes through the ChaCha20 construction.)

**Containers do not have their own entropy.** A dockerised node shares the host kernel's CSPRNG rather than having one of its own. The quality of every key Archon generates is therefore a property of the **host**, so that is where this is hardened, not in the image.

**The real risk is a cloned or freshly-booted image.** This is the one failure mode that could actually make Archon keys predictable, and it happens before any Archon code runs:

- A VM cloned from a snapshot taken *after* the CRNG was seeded starts life with the same CRNG state as every other clone. Two nodes from one golden image can generate the same mnemonic.
- A golden image that ships a `/var/lib/systemd/random-seed` (or equivalent) hands every instance the same seed file.
- An embedded or minimal system booting with no seed file and little interrupt activity can sit with an uninitialised CRNG.

`getrandom(2)` blocking until initialisation is the protection against the third case, and it is why nothing here silently falls back to weak randomness. It is **not** protection against the first two — a cloned seeded state looks perfectly initialised. If you build node images, generate identities after first boot, not in the image, and strip any seed file from the template.

### Mnemonic at rest

The mnemonic is stored encrypted, never in plaintext: PBKDF2-HMAC-SHA512 at **100,000 iterations** (`PBKDF2_ITERATIONS` overrides it) over a 16-byte random salt, then AES-GCM with a 12-byte random IV.

### Not configurable

Mnemonic strength cannot be raised through any public interface — `generateMnemonic()` takes no parameter in `Cipher`, `CipherBase`, or the Python port. A user *can* import a 24-word mnemonic via `newWallet(mnemonic)`, and a 256-bit mnemonic derives correctly, but Archon will never generate one.

Given the curve-matching argument above, this is defensible. It would only be worth changing as a hedge against future concerns about entropy quality rather than for present cryptographic strength.

### Summary

| property | value |
| --- | --- |
| Wallet seed entropy | **128 bits** (12-word BIP-39) |
| Derived key value | 256-bit secp256k1 scalar |
| Effective security | ~128 bits, matched to secp256k1 |
| Derivation | `m/44'/0'/{account}'/0/{index}`, deterministic |
| Chain wallets | same mnemonic, BIP-44/84 coin paths, fetched from Keymaster |
| Vault keys | ~256 bits, independent, **not** seed-recoverable |
| RNG | two implementations (`@noble/hashes`, `@noble/secp256k1`); both throw rather than degrading |
| Entropy origin | thermal noise (RDSEED, interrupt timing) → kernel CSPRNG → OpenSSL DRBG |
| Main RNG risk | cloned VM images / shipped seed files |
| Mnemonic at rest | PBKDF2-SHA512 100k iters + AES-GCM |
| TS / Python parity | both fixed at 128 bits |

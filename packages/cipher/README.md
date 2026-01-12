# Archon cipher

Archon cryptography utilities for encryption/decryption and creating/verifying signatures.

## Installation

```bash
npm install @didcid/cipher
```

## Usage

The cipher library comes in two versions for servers and web browsers.
The classes are identical but have different package dependencies.

### Node server applications

```js
// Import using subpaths
import CipherNode from '@didcid/cipher/node';

//Non-subpath import
import CipherNode from '@didcid/cipher';

const cipher = new CipherNode();
```

### Web browsers

```js
// Import using subpaths
import CipherWeb from '@didcid/cipher/web';

//Non-subpath import
import CipherWeb from '@didcid/cipher';

const cipher = new CipherWeb();
```

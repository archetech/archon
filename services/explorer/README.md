# DID Explorer

A React-based DID (Decentralized Identifier) explorer designed for viewing and interacting with DIDs and DID Documents on Bitcoin, Signet, and Hyperswarm networks. This explorer is developed using Vite with native TypeScript support.

## Project Setup

### Prerequisites

- Node.js (>=18.x recommended)

### Installation

From the `services/explorer` directory, install dependencies:

```bash
npm install
```

### Configuration

Copy the provided environment sample and configure the necessary variables:

```bash
cp sample.env .env
```

Then edit the `.env` file to set your desired configuration:

```env
# The port your explorer will run on
VITE_EXPLORER_PORT=4000

# Path prefix the app is served under. Baked into the bundle's asset URLs at
# build time AND used by server.js to decide where to mount, so the two must
# match — see "Serving under a prefix" below.
VITE_EXPLORER_BASE=/explorer/

# URLs the *browser* calls. Served at runtime from /explorer/config.json, so one
# image works for a local node and a public one; the values below are the
# build-time fallback used when that endpoint is unavailable.
VITE_GATEKEEPER_URL=http://localhost:4224
VITE_SEARCH_SERVER=http://localhost:4224

# Override what config.json serves, without rebuilding. On a publicly reachable
# node these should be the node's public gatekeeper, not loopback.
ARCHON_EXPLORER_GATEKEEPER_URL=
ARCHON_EXPLORER_SEARCH_URL=
```

### Serving under a prefix

The explorer is mounted at a path prefix (default `/explorer/`) rather than at
the root, so Drawbridge can expose it publicly on the node's own host at
`<public host>/explorer`. Herald links there by default.

Two consequences worth knowing:

- **The prefix is baked into the image.** Vite writes it into every asset URL at
  build time, so `VITE_EXPLORER_BASE` is a Docker build argument as well as a
  runtime variable. Changing it at runtime alone moves where express mounts the
  app while the assets stay baked at the old prefix, which breaks all of them.
- **Drawbridge does not strip the prefix**, unlike its `/names` and `/didcomm`
  routes, because the app is mounted at it.

Reaching the container directly on its port redirects `/` to the prefix, so both
paths behave the same.

### Backend URLs are resolved at runtime

`VITE_GATEKEEPER_URL` and `VITE_SEARCH_SERVER` are fetched by the **browser**,
not the server. Baking them in and defaulting to loopback meant a publicly
served explorer sent every visitor to their own machine. `server.js` now serves
them from `/explorer/config.json` and the app reads that before first paint,
falling back to the build-time values if the endpoint is unavailable.

### Running the Explorer

Start the explorer in development mode:

```bash
npm start
```

This will start the React app locally. Open your browser to view the explorer:

```
http://localhost:<VITE_EXPLORER_PORT>
```

(Replace `<VITE_EXPLORER_PORT>` with the port number you specified in `.env`)

## Building for Production

To create a production build, run:

```bash
npm run build
```

## Contributing

Feel free to open issues or submit pull requests for improvements and new features.



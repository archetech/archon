// Consumed as source by apps/keymaster-client and apps/gatekeeper-client, which
// alias this package in their vite configs. It has no build step, so the
// dependencies above are peers: the consuming app resolves them, and must supply
// a single copy (see the dedupe lists in each app's vite config).
//
// KeymasterUI takes `keymaster` as a prop and uses no React context, which is
// what lets it be shared this way and what makes it a different animal from
// packages/wallet-ui. See #99.
export { default as KeymasterUI } from './KeymasterUI.jsx';
export { default as TextInputModal } from './TextInputModal.jsx';
export { default as PollResultsModal } from './PollResultsModal.jsx';
export { default as WarningModal } from './WarningModal.jsx';

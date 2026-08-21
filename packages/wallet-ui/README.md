# @didcid/wallet-ui

React components and contexts shared by `apps/react-wallet` and
`apps/browser-extension`, which were previously two full copies of the same UI
(#894).

## Consumed as source, not as a build

The apps alias this package to `src/` and let their own Vite build compile the
TSX. There is no `dist/`, no build step, and nothing to rebuild between editing
a component and seeing it in either wallet.

## It declares no dependencies

React and MUI come from whichever app is building, resolved through that app's
bundler alias and `dedupe` list. Declaring them here — even as peers — makes
`npm ci` demand MUI's whole transitive tree in the root lockfile, and installing
them puts a *second* copy of React and MUI at the repo root. Two MUI instances
in one bundle means two emotion caches and broken theming.

## What belongs here

Components that are **presentational**: they render, they call handlers, and
they reach only for other shared code. Anything a component needs from its host
— platform capabilities, app state, navigation — is passed in.

The wallets differ in what their platform can do. react-wallet is a Capacitor
app with a camera and a notch; browser-extension is a chrome extension with
neither, and with chrome APIs the wallet does not have. A component that reaches
for one of those directly cannot be shared, so the capability is injected
instead: `SnackbarProvider` takes a `topOffset` because only react-wallet has a
safe-area inset to honour.

## What does not belong here

Anything importing `@capacitor/*`, `chrome.*`, or an app's own context. Those
are host concerns; a shared component receives their results as props.

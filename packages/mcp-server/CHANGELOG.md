# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

## 0.3.1 (2026-07-20)


### Bug Fixes

* extract lightweight service clients ([#707](https://github.com/archetech/archon/issues/707)) ([94b1698](https://github.com/archetech/archon/commit/94b1698b6cbd633db6f5bf911aaac16c95ee4ee2))
* report unfetchable asset bytes as an error, not as null ([#738](https://github.com/archetech/archon/issues/738)) ([#739](https://github.com/archetech/archon/issues/739)) ([0fd3cfc](https://github.com/archetech/archon/commit/0fd3cfcb961c0057800c547407a63bd11ba534cd)), closes [#734](https://github.com/archetech/archon/issues/734) [#737](https://github.com/archetech/archon/issues/737)
* return asset image/file tools as MCP content blocks ([#721](https://github.com/archetech/archon/issues/721)) ([#724](https://github.com/archetech/archon/issues/724)) ([3d6189a](https://github.com/archetech/archon/commit/3d6189a9b2448b6b49ee126490a8f1999a74bdeb))
* return MCP-spec tool results (isError, structuredContent) ([#719](https://github.com/archetech/archon/issues/719)) ([8242c99](https://github.com/archetech/archon/commit/8242c99c34386b7e1cb825a17b62b396d592e7ca)), closes [#691](https://github.com/archetech/archon/issues/691)


### Features

* add Archon MCP server ([#605](https://github.com/archetech/archon/issues/605)) ([7cb9b34](https://github.com/archetech/archon/commit/7cb9b340c4ea5fa9bc353f680f06ef05a38c49d5))
* author real input schemas for structured-object tools ([#727](https://github.com/archetech/archon/issues/727)) ([#732](https://github.com/archetech/archon/issues/732)) ([2ac744b](https://github.com/archetech/archon/commit/2ac744b91ad174219e5102087785d7043557f97d)), closes [#728](https://github.com/archetech/archon/issues/728)
* DIDComm Messaging v2 (Phases 0–7): TS + Python parity, transport, protocols, auto-discovery ([#633](https://github.com/archetech/archon/issues/633)) ([f53feef](https://github.com/archetech/archon/commit/f53feefc2a1e1fff1cc1ae86345dc1389de316c1)), closes [#key-1](https://github.com/archetech/archon/issues/key-1) [did#key-agreement-1](https://github.com/did/issues/key-agreement-1)
* expand MCP server toward Keymaster CLI parity ([#606](https://github.com/archetech/archon/issues/606)) ([8021d44](https://github.com/archetech/archon/commit/8021d4486d28003408234c2f33993389965d1dd1))
* implement the MCP resources capability ([#725](https://github.com/archetech/archon/issues/725)) ([#734](https://github.com/archetech/archon/issues/734)) ([1ba5d0d](https://github.com/archetech/archon/commit/1ba5d0dd8345f75b8f9ca231f217c63d744bba4d)), closes [#721](https://github.com/archetech/archon/issues/721)
* link large file assets instead of inlining base64 ([#735](https://github.com/archetech/archon/issues/735)) ([#737](https://github.com/archetech/archon/issues/737)) ([affdc35](https://github.com/archetech/archon/commit/affdc3554b9c172e61d1b64e5e4cb37510a760c9)), closes [#725](https://github.com/archetech/archon/issues/725) [#734](https://github.com/archetech/archon/issues/734)
* return vault items and dmail attachments as resource blocks ([#726](https://github.com/archetech/archon/issues/726)) ([#736](https://github.com/archetech/archon/issues/736)) ([44fad35](https://github.com/archetech/archon/commit/44fad354bc3d0176b8054b601597c38fbc7bad93)), closes [#725](https://github.com/archetech/archon/issues/725)
* type MCP tool handlers and declare selective output schemas ([#720](https://github.com/archetech/archon/issues/720)) ([#728](https://github.com/archetech/archon/issues/728)) ([c52586f](https://github.com/archetech/archon/commit/c52586f25a24d01b2faf9e49752bf01799b1fded)), closes [#727](https://github.com/archetech/archon/issues/727) [#724](https://github.com/archetech/archon/issues/724)


### BREAKING CHANGES

* MCP tool results no longer use the `{ ok, result }` /
`{ ok, error }` envelope. Failures set `isError: true` with the message as text;
successes return the payload as JSON text plus `structuredContent` for objects.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

* fix: gate structuredContent on the serialized payload

A JS object can serialize to a JSON scalar -- a Date, or anything with a
toJSON() returning a non-object -- so testing the raw result let a string
through as structuredContent, which MCP requires to be a JSON object. Gate on
the parsed payload instead, so the object guarantee holds by construction.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>





# [0.3.0](https://github.com/archetech/archon/compare/@didcid/mcp-server@0.2.0...@didcid/mcp-server@0.3.0) (2026-06-26)

**Note:** Version bump only for package @didcid/mcp-server





# 0.2.0 (2026-06-26)


### Features

* add Archon MCP server ([#605](https://github.com/archetech/archon/issues/605)) ([7cb9b34](https://github.com/archetech/archon/commit/7cb9b340c4ea5fa9bc353f680f06ef05a38c49d5))
* DIDComm Messaging v2 (Phases 0–7): TS + Python parity, transport, protocols, auto-discovery ([#633](https://github.com/archetech/archon/issues/633)) ([f53feef](https://github.com/archetech/archon/commit/f53feefc2a1e1fff1cc1ae86345dc1389de316c1)), closes [#key-1](https://github.com/archetech/archon/issues/key-1) [did#key-agreement-1](https://github.com/did/issues/key-agreement-1)
* expand MCP server toward Keymaster CLI parity ([#606](https://github.com/archetech/archon/issues/606)) ([8021d44](https://github.com/archetech/archon/commit/8021d4486d28003408234c2f33993389965d1dd1))





## [0.1.2](https://github.com/archetech/archon/compare/@didcid/mcp-server@0.1.1...@didcid/mcp-server@0.1.2) (2026-06-06)


### Bug Fixes

* normalize mcp inline payload results ([69bc73f](https://github.com/archetech/archon/commit/69bc73fd28d154c833538b9b48ebf53399d75580))


### Features

* expand mcp server cli parity ([85e7150](https://github.com/archetech/archon/commit/85e7150cdd64fb5e30f8f5f9c9e7072c2d6b51b9))





## 0.1.1 (2026-06-06)


### Features

* add Archon MCP server ([#605](https://github.com/archetech/archon/issues/605)) ([7cb9b34](https://github.com/archetech/archon/commit/7cb9b340c4ea5fa9bc353f680f06ef05a38c49d5))

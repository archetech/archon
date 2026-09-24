# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

# 0.2.0 (2026-09-24)


### Bug Fixes

* **dmail:** Make cc optional, and name the field that was wrong ([#932](https://github.com/archetech/archon/issues/932)) ([7a25724](https://github.com/archetech/archon/commit/7a25724e068fdf044463053f49cb6c28671c6f6a)), closes [#424](https://github.com/archetech/archon/issues/424)
* extract lightweight service clients ([#707](https://github.com/archetech/archon/issues/707)) ([94b1698](https://github.com/archetech/archon/commit/94b1698b6cbd633db6f5bf911aaac16c95ee4ee2))
* **gatekeeper:** require complete chain receipt metadata ([341a35f](https://github.com/archetech/archon/commit/341a35f2766bc52d42e2fdd20858f1641bb3b025))
* **gatekeeper:** require ordinals on chain receipts ([72d04b6](https://github.com/archetech/archon/commit/72d04b64becf2329ae3d56fcbb8f6c75c3878bc4))
* **herald:** Verify published credentials before showing them ([#946](https://github.com/archetech/archon/issues/946)) ([087800a](https://github.com/archetech/archon/commit/087800a40a08a1c4b2521ea171748e73918291a7)), closes [#676](https://github.com/archetech/archon/issues/676) [#945](https://github.com/archetech/archon/issues/945) [#947](https://github.com/archetech/archon/issues/947)
* **ipfs:** Replace the Helia backend with an in-memory store ([#1079](https://github.com/archetech/archon/issues/1079)) ([7239257](https://github.com/archetech/archon/commit/72392571e6bf3644595b989963705a880f1a766d)), closes [#1078](https://github.com/archetech/archon/issues/1078)
* **mediators:** distinguish batch and global import counts ([bfe98e7](https://github.com/archetech/archon/commit/bfe98e76e9ac51d771b3ad98401e7d54fe430f7b)), closes [#565](https://github.com/archetech/archon/issues/565)
* **mediators:** stop retrying batches for unrelated pending events ([#1169](https://github.com/archetech/archon/issues/1169)) ([9147291](https://github.com/archetech/archon/commit/914729144b10667ab5a883076d6f420dd446158c))
* Name the relationship an operation exercises, and the suite it signs under ([#1129](https://github.com/archetech/archon/issues/1129)) ([5d3d22b](https://github.com/archetech/archon/commit/5d3d22b435b0b11e6ad574a3965b2d82b95af0bc)), closes [#20](https://github.com/archetech/archon/issues/20) [#1127](https://github.com/archetech/archon/issues/1127)
* withdraw orphaned chain receipts during reorg recovery ([#1272](https://github.com/archetech/archon/issues/1272)) ([f0fa024](https://github.com/archetech/archon/commit/f0fa024df17b9d0e4332c9946fd2ac5b99209676))


### Features

* add immutable genesis document retrieval for anchored batches ([758fe72](https://github.com/archetech/archon/commit/758fe7249b8892e66fb713f1e74104e37e77af2f))
* Bind the proof configuration into DID operation proofs ([#1127](https://github.com/archetech/archon/issues/1127)) ([a2c894e](https://github.com/archetech/archon/commit/a2c894e95bd370a0a06ddc8a260d56b3903c6a78)), closes [#1085](https://github.com/archetech/archon/issues/1085) [#1087](https://github.com/archetech/archon/issues/1087)
* **didcomm:** Credential exchange over DIDComm (issue-credential 3.0) ([#919](https://github.com/archetech/archon/issues/919)) ([fce46f8](https://github.com/archetech/archon/commit/fce46f8d76f90f2614c1b05558b01c6a6d3a6848)), closes [#905](https://github.com/archetech/archon/issues/905) [#920](https://github.com/archetech/archon/issues/920)
* **keymaster:** add DID document check and repair commands ([#1259](https://github.com/archetech/archon/issues/1259)) ([8ba7113](https://github.com/archetech/archon/commit/8ba711342237b49bd072131dd28a1c230f1cb9c4))
* **keymaster:** Credentials other DID methods can verify ([#1085](https://github.com/archetech/archon/issues/1085)) ([d6eb9a0](https://github.com/archetech/archon/commit/d6eb9a05caf9c41733643f9a8fe73f86a495b4b2)), closes [#key-agreement-1](https://github.com/archetech/archon/issues/key-agreement-1) [#key-1](https://github.com/archetech/archon/issues/key-1) [#1052](https://github.com/archetech/archon/issues/1052) [123#key-1](https://github.com/123/issues/key-1) [#key-assertion-1](https://github.com/archetech/archon/issues/key-assertion-1) [#key-assertion-1](https://github.com/archetech/archon/issues/key-assertion-1)
* **keymaster:** Let a credential name the asset that holds it ([#948](https://github.com/archetech/archon/issues/948)) ([6c92ce0](https://github.com/archetech/archon/commit/6c92ce0ad3a1441d11275f6f15c7ccd48dd4e2a5)), closes [#108](https://github.com/archetech/archon/issues/108)
* **keymaster:** Let a user publish the assertion key ([#1102](https://github.com/archetech/archon/issues/1102)) ([e76cab3](https://github.com/archetech/archon/commit/e76cab37adb8e65bda1dd5f7bd6cb55763958b8f)), closes [#1085](https://github.com/archetech/archon/issues/1085)
* Separate acknowledging DIDComm messages from retrieving them ([#884](https://github.com/archetech/archon/issues/884)) ([56d095a](https://github.com/archetech/archon/commit/56d095a554093a6612dd5f7f212ddc3a24c1b848)), closes [#883](https://github.com/archetech/archon/issues/883)
* **wallet:** DIDComm messaging in the wallets ([#901](https://github.com/archetech/archon/issues/901)) ([befd33c](https://github.com/archetech/archon/commit/befd33c7df0eee64d5f39ec94c7034ff7373a9db)), closes [#646](https://github.com/archetech/archon/issues/646)





## 0.1.3 (2026-08-26)


### Bug Fixes

* **dmail:** Make cc optional, and name the field that was wrong ([#932](https://github.com/archetech/archon/issues/932)) ([7a25724](https://github.com/archetech/archon/commit/7a25724e068fdf044463053f49cb6c28671c6f6a)), closes [#424](https://github.com/archetech/archon/issues/424)
* extract lightweight service clients ([#707](https://github.com/archetech/archon/issues/707)) ([94b1698](https://github.com/archetech/archon/commit/94b1698b6cbd633db6f5bf911aaac16c95ee4ee2))
* **herald:** Verify published credentials before showing them ([#946](https://github.com/archetech/archon/issues/946)) ([087800a](https://github.com/archetech/archon/commit/087800a40a08a1c4b2521ea171748e73918291a7)), closes [#676](https://github.com/archetech/archon/issues/676) [#945](https://github.com/archetech/archon/issues/945) [#947](https://github.com/archetech/archon/issues/947)


### Features

* **didcomm:** Credential exchange over DIDComm (issue-credential 3.0) ([#919](https://github.com/archetech/archon/issues/919)) ([fce46f8](https://github.com/archetech/archon/commit/fce46f8d76f90f2614c1b05558b01c6a6d3a6848)), closes [#905](https://github.com/archetech/archon/issues/905) [#920](https://github.com/archetech/archon/issues/920)
* **keymaster:** Let a credential name the asset that holds it ([#948](https://github.com/archetech/archon/issues/948)) ([6c92ce0](https://github.com/archetech/archon/commit/6c92ce0ad3a1441d11275f6f15c7ccd48dd4e2a5)), closes [#108](https://github.com/archetech/archon/issues/108)
* Separate acknowledging DIDComm messages from retrieving them ([#884](https://github.com/archetech/archon/issues/884)) ([56d095a](https://github.com/archetech/archon/commit/56d095a554093a6612dd5f7f212ddc3a24c1b848)), closes [#883](https://github.com/archetech/archon/issues/883)
* **wallet:** DIDComm messaging in the wallets ([#901](https://github.com/archetech/archon/issues/901)) ([befd33c](https://github.com/archetech/archon/commit/befd33c7df0eee64d5f39ec94c7034ff7373a9db)), closes [#646](https://github.com/archetech/archon/issues/646)





## 0.1.2 (2026-07-31)


### Bug Fixes

* extract lightweight service clients ([#707](https://github.com/archetech/archon/issues/707)) ([94b1698](https://github.com/archetech/archon/commit/94b1698b6cbd633db6f5bf911aaac16c95ee4ee2))





## 0.1.1 (2026-07-20)


### Bug Fixes

* extract lightweight service clients ([#707](https://github.com/archetech/archon/issues/707)) ([94b1698](https://github.com/archetech/archon/commit/94b1698b6cbd633db6f5bf911aaac16c95ee4ee2))

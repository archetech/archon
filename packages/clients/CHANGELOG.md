# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

# 0.4.0 (2026-11-27)


### Bug Fixes

* **cashu:** say why a mint cannot be read, and do not save one that cannot ([#1533](https://github.com/archetech/archon/issues/1533)) ([0f5d856](https://github.com/archetech/archon/commit/0f5d85682778fcb79c74c7f66a24f09e88f61a17))
* **clients:** make a value in a request's path one segment of it, whatever it holds ([#1756](https://github.com/archetech/archon/issues/1756)) ([940dc06](https://github.com/archetech/archon/commit/940dc0672c7cee29b779e4cb75bddd307a0e2bee))
* **keymaster:** protect Lightning funds when removing a wallet or identity ([#1548](https://github.com/archetech/archon/issues/1548)) ([e1f68b5](https://github.com/archetech/archon/commit/e1f68b58575ab6bf816f2510ab7d772f3cdea55a))
* **keymaster:** remember an asset whose deletion awaits anchoring, and show a grant's revocation after a reload ([#1708](https://github.com/archetech/archon/issues/1708)) ([a9d22ff](https://github.com/archetech/archon/commit/a9d22fffafdf34914073ee122afd9e9c9cdee5df)), closes [#1700](https://github.com/archetech/archon/issues/1700)


### Features

* **cashu:** add an optional node mint behind Drawbridge ([#1517](https://github.com/archetech/archon/issues/1517)) ([dd946bb](https://github.com/archetech/archon/commit/dd946bbd86307b3db26c21c85911348d94cf3cd5)), closes [#1058](https://github.com/archetech/archon/issues/1058)
* **cashu:** add the Cashu commands to the SDKs, CLIs and MCP ([#1525](https://github.com/archetech/archon/issues/1525)) ([0647109](https://github.com/archetech/archon/commit/06471097da6b012d50021774458fea75b3273086))
* **cashu:** add the Keymaster wallet and REST API in both ports ([#1520](https://github.com/archetech/archon/issues/1520)) ([e41272c](https://github.com/archetech/archon/commit/e41272ced5a6b1eaa850af4eaf9a44cf9e4ffafe))
* **cashu:** send ecash locked to a DID over DIDComm ([#1526](https://github.com/archetech/archon/issues/1526)) ([0c46631](https://github.com/archetech/archon/commit/0c46631a64703d0c9987bbce458cac6a71d47558))
* **drawbridge:** accept Cashu as HTTP 402 payment (NUT-24) ([#1598](https://github.com/archetech/archon/issues/1598)) ([85eebf9](https://github.com/archetech/archon/commit/85eebf969c3e8974e2f05daf39952b2f605d0efd)), closes [#1596](https://github.com/archetech/archon/issues/1596)
* **gatekeeper:** a change feed listing the DIDs whose histories changed since a sequence ([#1690](https://github.com/archetech/archon/issues/1690)) ([8b0ed8d](https://github.com/archetech/archon/commit/8b0ed8da23cd87493d9d84ef71902fe133ae0e89))
* **gatekeeper:** bound a read of a CID's content, by the node's limit or a lower one the caller asks for ([#1751](https://github.com/archetech/archon/issues/1751)) ([f41607d](https://github.com/archetech/archon/commit/f41607d885afc3242a4d365ef578a8b1b32ba067))
* **gatekeeper:** resolve every version of one or more DIDs in one request ([#1692](https://github.com/archetech/archon/issues/1692)) ([86b74d5](https://github.com/archetech/archon/commit/86b74d57e091ab843370d715001016ce05980a7d))
* **keymaster-ui:** give the standalone clients the wallets' Grants section, under Auth ([#1727](https://github.com/archetech/archon/issues/1727)) ([8e5eb01](https://github.com/archetech/archon/commit/8e5eb01255f29d02e377bd45d54897fe561cfe28))
* **keymaster:** make, list, change and revoke an app's grant from the command line and MCP ([#1716](https://github.com/archetech/archon/issues/1716)) ([0199e71](https://github.com/archetech/archon/commit/0199e716045dcd8d50cd17223c9943e924076165))
* **keymaster:** pay a Cashu payment request ([#1605](https://github.com/archetech/archon/issues/1605)) ([ee48af1](https://github.com/archetech/archon/commit/ee48af1ebd089c21180f4641a5a2f98f31bcc21c)), closes [#1596](https://github.com/archetech/archon/issues/1596)
* **memepool:** publish an article, whose body the service stores and pins ([#1724](https://github.com/archetech/archon/issues/1724)) ([a5b1797](https://github.com/archetech/archon/commit/a5b179705d511b8ddcd1af56626a6e38a9c4e5a5))
* **wallet-ui:** decode and pay a Cashu payment request from the Cashu view ([#1606](https://github.com/archetech/archon/issues/1606)) ([a84d5cf](https://github.com/archetech/archon/commit/a84d5cffda07607c7a8c951287168cee7b519a73)), closes [#1596](https://github.com/archetech/archon/issues/1596)



# 0.14.0 (2026-10-30)


### Bug Fixes

* **dmail:** Make cc optional, and name the field that was wrong ([#932](https://github.com/archetech/archon/issues/932)) ([7a25724](https://github.com/archetech/archon/commit/7a25724e068fdf044463053f49cb6c28671c6f6a)), closes [#424](https://github.com/archetech/archon/issues/424)
* extract lightweight service clients ([#707](https://github.com/archetech/archon/issues/707)) ([94b1698](https://github.com/archetech/archon/commit/94b1698b6cbd633db6f5bf911aaac16c95ee4ee2))
* **gatekeeper:** require complete chain receipt metadata ([341a35f](https://github.com/archetech/archon/commit/341a35f2766bc52d42e2fdd20858f1641bb3b025))
* **gatekeeper:** require ordinals on chain receipts ([72d04b6](https://github.com/archetech/archon/commit/72d04b64becf2329ae3d56fcbb8f6c75c3878bc4))
* **herald:** Verify published credentials before showing them ([#946](https://github.com/archetech/archon/issues/946)) ([087800a](https://github.com/archetech/archon/commit/087800a40a08a1c4b2521ea171748e73918291a7)), closes [#676](https://github.com/archetech/archon/issues/676) [#945](https://github.com/archetech/archon/issues/945) [#947](https://github.com/archetech/archon/issues/947)
* **ipfs:** Replace the Helia backend with an in-memory store ([#1079](https://github.com/archetech/archon/issues/1079)) ([7239257](https://github.com/archetech/archon/commit/72392571e6bf3644595b989963705a880f1a766d)), closes [#1078](https://github.com/archetech/archon/issues/1078)
* **keymaster:** report Gatekeeper timeouts as 504 and outages as 503 ([#1389](https://github.com/archetech/archon/issues/1389)) ([852a494](https://github.com/archetech/archon/commit/852a494c2bceb904162989e67b0b49d78d5e922a)), closes [#1380](https://github.com/archetech/archon/issues/1380)
* **mediators:** distinguish batch and global import counts ([bfe98e7](https://github.com/archetech/archon/commit/bfe98e76e9ac51d771b3ad98401e7d54fe430f7b)), closes [#565](https://github.com/archetech/archon/issues/565)
* **mediators:** stop retrying batches for unrelated pending events ([#1169](https://github.com/archetech/archon/issues/1169)) ([9147291](https://github.com/archetech/archon/commit/914729144b10667ab5a883076d6f420dd446158c))
* Name the relationship an operation exercises, and the suite it signs under ([#1129](https://github.com/archetech/archon/issues/1129)) ([5d3d22b](https://github.com/archetech/archon/commit/5d3d22b435b0b11e6ad574a3965b2d82b95af0bc)), closes [#20](https://github.com/archetech/archon/issues/20) [#1127](https://github.com/archetech/archon/issues/1127)
* withdraw orphaned chain receipts during reorg recovery ([#1272](https://github.com/archetech/archon/issues/1272)) ([f0fa024](https://github.com/archetech/archon/commit/f0fa024df17b9d0e4332c9946fd2ac5b99209676))


### Features

* add immutable genesis document retrieval for anchored batches ([758fe72](https://github.com/archetech/archon/commit/758fe7249b8892e66fb713f1e74104e37e77af2f))
* Bind the proof configuration into DID operation proofs ([#1127](https://github.com/archetech/archon/issues/1127)) ([a2c894e](https://github.com/archetech/archon/commit/a2c894e95bd370a0a06ddc8a260d56b3903c6a78)), closes [#1085](https://github.com/archetech/archon/issues/1085) [#1087](https://github.com/archetech/archon/issues/1087)
* **didcomm:** Credential exchange over DIDComm (issue-credential 3.0) ([#919](https://github.com/archetech/archon/issues/919)) ([fce46f8](https://github.com/archetech/archon/commit/fce46f8d76f90f2614c1b05558b01c6a6d3a6848)), closes [#905](https://github.com/archetech/archon/issues/905) [#920](https://github.com/archetech/archon/issues/920)
* **gatekeeper:** page accepted events across DIDs with GET /api/v1/events ([#1335](https://github.com/archetech/archon/issues/1335)) ([d65b752](https://github.com/archetech/archon/commit/d65b752635e0cd53c857809cf797b088606f3aa8)), closes [#1332](https://github.com/archetech/archon/issues/1332)
* **gatekeeper:** resolve a DID at a versionId ([#1463](https://github.com/archetech/archon/issues/1463)) ([9c11b53](https://github.com/archetech/archon/commit/9c11b530a1b77d000eeb439147861bfa2f56356b))
* **keymaster:** add DID document check and repair commands ([#1259](https://github.com/archetech/archon/issues/1259)) ([8ba7113](https://github.com/archetech/archon/commit/8ba711342237b49bd072131dd28a1c230f1cb9c4))
* **keymaster:** Credentials other DID methods can verify ([#1085](https://github.com/archetech/archon/issues/1085)) ([d6eb9a0](https://github.com/archetech/archon/commit/d6eb9a05caf9c41733643f9a8fe73f86a495b4b2)), closes [#key-agreement-1](https://github.com/archetech/archon/issues/key-agreement-1) [#key-1](https://github.com/archetech/archon/issues/key-1) [#1052](https://github.com/archetech/archon/issues/1052) [123#key-1](https://github.com/123/issues/key-1) [#key-assertion-1](https://github.com/archetech/archon/issues/key-assertion-1) [#key-assertion-1](https://github.com/archetech/archon/issues/key-assertion-1)
* **keymaster:** Let a credential name the asset that holds it ([#948](https://github.com/archetech/archon/issues/948)) ([6c92ce0](https://github.com/archetech/archon/commit/6c92ce0ad3a1441d11275f6f15c7ccd48dd4e2a5)), closes [#108](https://github.com/archetech/archon/issues/108)
* **keymaster:** Let a user publish the assertion key ([#1102](https://github.com/archetech/archon/issues/1102)) ([e76cab3](https://github.com/archetech/archon/commit/e76cab37adb8e65bda1dd5f7bd6cb55763958b8f)), closes [#1085](https://github.com/archetech/archon/issues/1085)
* **keymaster:** support historical verification of credential responses ([#1299](https://github.com/archetech/archon/issues/1299)) ([79b6606](https://github.com/archetech/archon/commit/79b660620ed0e5576337afbf63145b7f8609fd6a)), closes [#1290](https://github.com/archetech/archon/issues/1290) [#1300](https://github.com/archetech/archon/issues/1300)
* Separate acknowledging DIDComm messages from retrieving them ([#884](https://github.com/archetech/archon/issues/884)) ([56d095a](https://github.com/archetech/archon/commit/56d095a554093a6612dd5f7f212ddc3a24c1b848)), closes [#883](https://github.com/archetech/archon/issues/883)
* **wallet:** DIDComm messaging in the wallets ([#901](https://github.com/archetech/archon/issues/901)) ([befd33c](https://github.com/archetech/archon/commit/befd33c7df0eee64d5f39ec94c7034ff7373a9db)), closes [#646](https://github.com/archetech/archon/issues/646)





# 0.3.0 (2026-10-30)


### Bug Fixes

* **dmail:** Make cc optional, and name the field that was wrong ([#932](https://github.com/archetech/archon/issues/932)) ([7a25724](https://github.com/archetech/archon/commit/7a25724e068fdf044463053f49cb6c28671c6f6a)), closes [#424](https://github.com/archetech/archon/issues/424)
* extract lightweight service clients ([#707](https://github.com/archetech/archon/issues/707)) ([94b1698](https://github.com/archetech/archon/commit/94b1698b6cbd633db6f5bf911aaac16c95ee4ee2))
* **gatekeeper:** require complete chain receipt metadata ([341a35f](https://github.com/archetech/archon/commit/341a35f2766bc52d42e2fdd20858f1641bb3b025))
* **gatekeeper:** require ordinals on chain receipts ([72d04b6](https://github.com/archetech/archon/commit/72d04b64becf2329ae3d56fcbb8f6c75c3878bc4))
* **herald:** Verify published credentials before showing them ([#946](https://github.com/archetech/archon/issues/946)) ([087800a](https://github.com/archetech/archon/commit/087800a40a08a1c4b2521ea171748e73918291a7)), closes [#676](https://github.com/archetech/archon/issues/676) [#945](https://github.com/archetech/archon/issues/945) [#947](https://github.com/archetech/archon/issues/947)
* **ipfs:** Replace the Helia backend with an in-memory store ([#1079](https://github.com/archetech/archon/issues/1079)) ([7239257](https://github.com/archetech/archon/commit/72392571e6bf3644595b989963705a880f1a766d)), closes [#1078](https://github.com/archetech/archon/issues/1078)
* **keymaster:** report Gatekeeper timeouts as 504 and outages as 503 ([#1389](https://github.com/archetech/archon/issues/1389)) ([852a494](https://github.com/archetech/archon/commit/852a494c2bceb904162989e67b0b49d78d5e922a)), closes [#1380](https://github.com/archetech/archon/issues/1380)
* **mediators:** distinguish batch and global import counts ([bfe98e7](https://github.com/archetech/archon/commit/bfe98e76e9ac51d771b3ad98401e7d54fe430f7b)), closes [#565](https://github.com/archetech/archon/issues/565)
* **mediators:** stop retrying batches for unrelated pending events ([#1169](https://github.com/archetech/archon/issues/1169)) ([9147291](https://github.com/archetech/archon/commit/914729144b10667ab5a883076d6f420dd446158c))
* Name the relationship an operation exercises, and the suite it signs under ([#1129](https://github.com/archetech/archon/issues/1129)) ([5d3d22b](https://github.com/archetech/archon/commit/5d3d22b435b0b11e6ad574a3965b2d82b95af0bc)), closes [#20](https://github.com/archetech/archon/issues/20) [#1127](https://github.com/archetech/archon/issues/1127)
* withdraw orphaned chain receipts during reorg recovery ([#1272](https://github.com/archetech/archon/issues/1272)) ([f0fa024](https://github.com/archetech/archon/commit/f0fa024df17b9d0e4332c9946fd2ac5b99209676))


### Features

* add immutable genesis document retrieval for anchored batches ([758fe72](https://github.com/archetech/archon/commit/758fe7249b8892e66fb713f1e74104e37e77af2f))
* Bind the proof configuration into DID operation proofs ([#1127](https://github.com/archetech/archon/issues/1127)) ([a2c894e](https://github.com/archetech/archon/commit/a2c894e95bd370a0a06ddc8a260d56b3903c6a78)), closes [#1085](https://github.com/archetech/archon/issues/1085) [#1087](https://github.com/archetech/archon/issues/1087)
* **didcomm:** Credential exchange over DIDComm (issue-credential 3.0) ([#919](https://github.com/archetech/archon/issues/919)) ([fce46f8](https://github.com/archetech/archon/commit/fce46f8d76f90f2614c1b05558b01c6a6d3a6848)), closes [#905](https://github.com/archetech/archon/issues/905) [#920](https://github.com/archetech/archon/issues/920)
* **gatekeeper:** page accepted events across DIDs with GET /api/v1/events ([#1335](https://github.com/archetech/archon/issues/1335)) ([d65b752](https://github.com/archetech/archon/commit/d65b752635e0cd53c857809cf797b088606f3aa8)), closes [#1332](https://github.com/archetech/archon/issues/1332)
* **gatekeeper:** resolve a DID at a versionId ([#1463](https://github.com/archetech/archon/issues/1463)) ([9c11b53](https://github.com/archetech/archon/commit/9c11b530a1b77d000eeb439147861bfa2f56356b))
* **keymaster:** add DID document check and repair commands ([#1259](https://github.com/archetech/archon/issues/1259)) ([8ba7113](https://github.com/archetech/archon/commit/8ba711342237b49bd072131dd28a1c230f1cb9c4))
* **keymaster:** Credentials other DID methods can verify ([#1085](https://github.com/archetech/archon/issues/1085)) ([d6eb9a0](https://github.com/archetech/archon/commit/d6eb9a05caf9c41733643f9a8fe73f86a495b4b2)), closes [#key-agreement-1](https://github.com/archetech/archon/issues/key-agreement-1) [#key-1](https://github.com/archetech/archon/issues/key-1) [#1052](https://github.com/archetech/archon/issues/1052) [123#key-1](https://github.com/123/issues/key-1) [#key-assertion-1](https://github.com/archetech/archon/issues/key-assertion-1) [#key-assertion-1](https://github.com/archetech/archon/issues/key-assertion-1)
* **keymaster:** Let a credential name the asset that holds it ([#948](https://github.com/archetech/archon/issues/948)) ([6c92ce0](https://github.com/archetech/archon/commit/6c92ce0ad3a1441d11275f6f15c7ccd48dd4e2a5)), closes [#108](https://github.com/archetech/archon/issues/108)
* **keymaster:** Let a user publish the assertion key ([#1102](https://github.com/archetech/archon/issues/1102)) ([e76cab3](https://github.com/archetech/archon/commit/e76cab37adb8e65bda1dd5f7bd6cb55763958b8f)), closes [#1085](https://github.com/archetech/archon/issues/1085)
* **keymaster:** support historical verification of credential responses ([#1299](https://github.com/archetech/archon/issues/1299)) ([79b6606](https://github.com/archetech/archon/commit/79b660620ed0e5576337afbf63145b7f8609fd6a)), closes [#1290](https://github.com/archetech/archon/issues/1290) [#1300](https://github.com/archetech/archon/issues/1300)
* Separate acknowledging DIDComm messages from retrieving them ([#884](https://github.com/archetech/archon/issues/884)) ([56d095a](https://github.com/archetech/archon/commit/56d095a554093a6612dd5f7f212ddc3a24c1b848)), closes [#883](https://github.com/archetech/archon/issues/883)
* **wallet:** DIDComm messaging in the wallets ([#901](https://github.com/archetech/archon/issues/901)) ([befd33c](https://github.com/archetech/archon/commit/befd33c7df0eee64d5f39ec94c7034ff7373a9db)), closes [#646](https://github.com/archetech/archon/issues/646)





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

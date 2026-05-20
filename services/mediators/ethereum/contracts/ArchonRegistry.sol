// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract ArchonRegistry {
    event ArchonBatch(
        address indexed sender,
        bytes32 indexed batchHash,
        string batchDid,
        uint256 opCount
    );

    uint256 public constant MAX_BATCH_DID_BYTES = 128;

    function anchorBatch(bytes32 batchHash, string calldata batchDid, uint256 opCount) external {
        require(batchHash != bytes32(0), "empty batchHash");
        require(bytes(batchDid).length > 0, "empty batchDid");
        require(bytes(batchDid).length <= MAX_BATCH_DID_BYTES, "batchDid too long");
        emit ArchonBatch(msg.sender, batchHash, batchDid, opCount);
    }
}

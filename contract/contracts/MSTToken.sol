// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title MST — Meta Assets 矿工凭证 NFT
/// @notice 仅基金会地址（owner）可铸造；持有者可批量质押进 RewardSystemV2 矿池，每枚权重 1。
contract MSTToken is ERC721Enumerable, Ownable {
    uint256 private _nextId = 1;

    error ZeroQuantity();

    constructor(address foundation) ERC721("MST", "MST") Ownable(foundation) {}

    /// @notice 基金会批量铸造，tokenId 自 1 起连续递增
    /// @dev 单笔数量受区块 gas 上限约束，链下按 ≤100/笔 分批调用
    function mint(address to, uint256 quantity) external onlyOwner {
        if (quantity == 0) revert ZeroQuantity();
        uint256 id = _nextId;
        for (uint256 i; i < quantity; ++i) {
            _safeMint(to, id + i);
        }
        _nextId = id + quantity;
    }
}

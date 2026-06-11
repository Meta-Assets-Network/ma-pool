// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// 链上现状（init_proxy_pool.sol）。与原文唯一差异：import 路径不带内联版本号，
// 包版本由 package.json 精确锁定为 @openzeppelin/contracts-upgradeable@5.0.2。
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

contract RewardSystem is Initializable, UUPSUpgradeable, OwnableUpgradeable {
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address initialOwner) public initializer {
        __Ownable_init(initialOwner);
        __UUPSUpgradeable_init();
    }

    function _authorizeUpgrade(address newImplementation)
        internal
        override
        onlyOwner
    {}

    function rewardForBlock(uint256 /* blockNumber */)
        external
        pure
        returns (uint256)
    {
        return 1e18;
    }

    function sweepAddress()
        external
        pure
        returns (address)
    {
        return 0x281F73d00751aEb5f64e76c8B9137d3AA8499762;
    }
}

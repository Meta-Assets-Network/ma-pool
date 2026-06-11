// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// OZ 5.x
import "@openzeppelin/contracts-upgradeable@5.0.2/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable@5.0.2/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable@5.0.2/access/OwnableUpgradeable.sol";

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
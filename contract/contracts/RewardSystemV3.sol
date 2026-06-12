// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/// @title RewardSystemV3 — Meta Assets Chain POCC 矿池（RewardSystemV2 的 UUPS 升级实现）
/// @notice 链端每块通过受限 gas（100k）的 StaticCall 读取本合约：
///         `rewardForBlock(height)` 决定产量（保持 1e18 = 1 MA），
///         `sweepAddress()` 以当前区块高度派生的随机数在激活矿工间加权随机，
///         返回本块奖励与手续费的归集地址（不参与出块者选择）。
///         虚拟矿池：只计算、不记账、不持有奖励资金。
/// @dev    solc 0.8.24 / OZ 5.0.2，与链上 V1/V2 一致；ERC-7201 命名空间存储。
///         V3 变更：
///         1. `sweepAddress()` 抽样从 O(n) 线性扫描改为 Fenwick 树 O(log n) 下降，
///            gas 与激活矿工数无关（~43k），永不触碰链端 100k 上限；
///            V2 实现约 22 个激活矿工即 OOG 回退 fallback。
///         2. `activate()` 增加 FEN_CAPACITY（65536）容量上限。
///         3. `setNft()` 增加 totalStaked == 0 守卫，防止存量质押下切换 NFT
///            合约导致用户 NFT 永久滞留。
///         存储仅在 PoolStorage 末尾追加 `fen` 映射，V2 字段一字未动，布局兼容。
///         父合约初始化已在 V1 完成，V3 仅需 reinitializer(3) 的 initializeV3
///         —— 因此豁免插件的 missing-initializer 误报。
/// @custom:oz-upgrades-unsafe-allow missing-initializer
contract RewardSystemV3 is Initializable, UUPSUpgradeable, OwnableUpgradeable {
    // ---------------------------------------------------------------- 常量

    /// @notice 激活矿工的最低质押数量（权重门槛 100）
    uint256 public constant MIN_ACTIVATION = 100;
    /// @notice 权重定点系数：算力 CU = weight / WEIGHT_SCALE
    uint256 public constant WEIGHT_SCALE = 10000;
    /// @notice 激活矿工容量上限 = Fenwick 树固定规模（2^16，树深 17 层）
    uint256 public constant FEN_CAPACITY = 65536;

    uint256 private constant TIER2_COUNT = 600; // ≥600 → 1.05x
    uint256 private constant TIER3_COUNT = 6000; // ≥6000 → 1.15x（封顶档）
    uint256 private constant TIER1_BPS = 10000;
    uint256 private constant TIER2_BPS = 10500;
    uint256 private constant TIER3_BPS = 11500;

    // ---------------------------------------------------------------- 存储

    struct MinerData {
        uint256 staked; // 已质押 MST 数量
        bool active; // 是否在出块候选集
        uint256 listIndex; // 在 minerList 中的下标
        uint256 activeIndex; // 在 activeList 中的下标（active 时有效）
        uint256[] tokens; // 质押中的 tokenId 列表
        mapping(uint256 => uint256) tokenPos; // tokenId => tokens 下标 + 1
    }

    /// @custom:storage-location erc7201:machain.storage.RewardPool
    struct PoolStorage {
        // ↓↓↓ V1/V2 既有字段，顺序与类型禁止改动 ↓↓↓
        IERC721 nft; // MST 合约
        address fallbackAddress; // 无激活矿工时的 sweep 接收地址
        uint256 totalWeight; // 所有激活矿工权重之和（加权随机的分母）
        uint256 totalStaked; // 池内 MST 总量
        address[] minerList; // 所有质押者
        address[] activeList; // 激活矿工
        mapping(address => MinerData) miners;
        mapping(uint256 => address) stakerOf_; // tokenId => 质押者
        // ↓↓↓ V3 追加 ↓↓↓
        // Fenwick 树（树状数组），1-indexed：
        // fen[j] = activeList 下标区间 (j - lsb(j) - 1, j - 1] 内激活矿工的权重和。
        // 不变量：fen[FEN_CAPACITY] == totalWeight。
        mapping(uint256 => uint256) fen;
    }

    // keccak256(abi.encode(uint256(keccak256("machain.storage.RewardPool")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant POOL_STORAGE_LOCATION =
        0xb58d6ebea3fe050b335ec9e23b86a3b1c6750142428039386b2ba5577aeb4a00;

    function _s() private pure returns (PoolStorage storage $) {
        assembly {
            $.slot := POOL_STORAGE_LOCATION
        }
    }

    // ---------------------------------------------------------------- 事件（miner 均 indexed，支持按地址+区块区间 getLogs）

    event Staked(address indexed miner, uint256 amount, uint256 stakedAfter, uint256[] tokenIds);
    event Unstaked(address indexed miner, uint256 amount, uint256 stakedAfter, uint256[] tokenIds);
    event MinerActivated(address indexed miner, uint256 staked, uint256 weight);
    event MinerDeactivated(address indexed miner, uint256 staked);
    event NftContractSet(address indexed nft);
    event FallbackAddressSet(address indexed fallbackAddress);

    // ---------------------------------------------------------------- 错误

    error EmptyTokenList();
    error NftNotConfigured();
    error BelowActivationThreshold(uint256 staked, uint256 required);
    error AlreadyActive();
    error NotActive();
    error NotTokenStaker(uint256 tokenId);
    error ZeroAddress();
    error CapacityExceeded();
    error StakeNotEmpty();

    // ---------------------------------------------------------------- 初始化 / 升级

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice V2 → V3 升级后的一次性初始化：把现存激活矿工的权重灌入 Fenwick 树。
    /// @dev    必须与升级同笔执行（upgradeToAndCall），否则中间区块的 sweepAddress()
    ///         会因树为空而越界 revert，链端落到 HardcodedSweepFallback。
    function initializeV3() external reinitializer(3) onlyOwner {
        PoolStorage storage $ = _s();
        uint256 len = $.activeList.length;
        if (len > FEN_CAPACITY) revert CapacityExceeded();
        for (uint256 i; i < len; ++i) {
            _fenAdd($, i + 1, int256(weightFor($.miners[$.activeList[i]].staked)));
        }
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    // ---------------------------------------------------------------- 管理

    /// @notice 设置 MST 合约。V3 起仅允许在池内无存量质押时调用：
    ///         unstake 用当前 nft 做 transferFrom，存量质押下切换会令旧 NFT 永久滞留。
    function setNft(address nft_) external onlyOwner {
        if (nft_ == address(0)) revert ZeroAddress();
        PoolStorage storage $ = _s();
        if ($.totalStaked != 0) revert StakeNotEmpty();
        $.nft = IERC721(nft_);
        emit NftContractSet(nft_);
    }

    function setFallbackAddress(address fallback_) external onlyOwner {
        if (fallback_ == address(0)) revert ZeroAddress();
        _s().fallbackAddress = fallback_;
        emit FallbackAddressSet(fallback_);
    }

    // ---------------------------------------------------------------- 链端共识读接口

    /// @notice 指定高度的出块奖励。语义自 V1 起不变：恒为 1e18（1 MA）。
    function rewardForBlock(uint256 /* blockNumber */) external pure returns (uint256) {
        return 1e18;
    }

    /// @notice 本高度奖励/手续费归集地址。无激活矿工时返回 fallbackAddress；
    ///         否则以 currentSeed() 在激活矿工间按权重（staked × 段位系数）加权随机命中。
    /// @dev    V3：Fenwick 树前缀和下降定位，固定 17 次 SLOAD（~43k gas），
    ///         与激活矿工数无关。selector 与 V1/V2 一致，链端调用方零改动。
    ///         树与 totalWeight 若意外失同步将数组越界 revert —— 链端
    ///         GetRegistrySweepAddress 对调用失败统一回退 HardcodedSweepFallback，
    ///         兜底语义与 V2 的防御分支等价。
    function sweepAddress() external view returns (address) {
        PoolStorage storage $ = _s();
        uint256 tw = $.totalWeight;
        if (tw == 0) return $.fallbackAddress;

        (, bytes32 seed) = currentSeed();
        return $.activeList[_fenFind($, uint256(seed) % tw)];
    }

    /// @notice 出块随机源：当前区块高度 + 上一块哈希。同一高度内确定，跨高度变化。
    function currentSeed() public view returns (uint256 blockNumber, bytes32 seed) {
        blockNumber = block.number;
        seed = keccak256(abi.encodePacked(block.number, blockhash(block.number - 1)));
    }

    // ---------------------------------------------------------------- 段位 / 权重（纯函数，前端与链下可直接复算）

    /// @notice 质押数量对应的段位系数（bps）：<600→1.00x，<6000→1.05x，≥6000→1.15x 封顶
    function multiplierBpsFor(uint256 stakedCount) public pure returns (uint256) {
        if (stakedCount >= TIER3_COUNT) return TIER3_BPS;
        if (stakedCount >= TIER2_COUNT) return TIER2_BPS;
        return TIER1_BPS;
    }

    /// @notice 质押数量对应的权重（= 数量 × 系数 bps；CU = weight / WEIGHT_SCALE）
    function weightFor(uint256 stakedCount) public pure returns (uint256) {
        return stakedCount * multiplierBpsFor(stakedCount);
    }

    // ---------------------------------------------------------------- 质押 / 激活

    /// @notice 批量质押 MST（需先对本合约 setApprovalForAll）
    function stake(uint256[] calldata tokenIds) external {
        if (tokenIds.length == 0) revert EmptyTokenList();
        PoolStorage storage $ = _s();
        IERC721 nft = $.nft;
        if (address(nft) == address(0)) revert NftNotConfigured();

        MinerData storage md = $.miners[msg.sender];
        uint256 wasWeight = md.active ? weightFor(md.staked) : 0;

        if (md.staked == 0 && md.tokens.length == 0) {
            md.listIndex = $.minerList.length;
            $.minerList.push(msg.sender);
        }

        for (uint256 i; i < tokenIds.length; ++i) {
            uint256 id = tokenIds[i];
            nft.transferFrom(msg.sender, address(this), id);
            $.stakerOf_[id] = msg.sender;
            md.tokens.push(id);
            md.tokenPos[id] = md.tokens.length; // index + 1
        }

        md.staked += tokenIds.length;
        $.totalStaked += tokenIds.length;
        _syncWeight($, md, wasWeight);

        emit Staked(msg.sender, tokenIds.length, md.staked, tokenIds);
    }

    /// @notice 批量取回自己质押的 MST；激活中跌破 100 将自动失活
    function unstake(uint256[] calldata tokenIds) external {
        if (tokenIds.length == 0) revert EmptyTokenList();
        PoolStorage storage $ = _s();
        MinerData storage md = $.miners[msg.sender];
        uint256 wasWeight = md.active ? weightFor(md.staked) : 0;

        for (uint256 i; i < tokenIds.length; ++i) {
            uint256 id = tokenIds[i];
            if ($.stakerOf_[id] != msg.sender) revert NotTokenStaker(id);
            delete $.stakerOf_[id];

            // tokens 数组 swap-remove
            uint256 pos = md.tokenPos[id]; // index + 1
            uint256 lastIdx = md.tokens.length - 1;
            uint256 lastId = md.tokens[lastIdx];
            if (pos - 1 != lastIdx) {
                md.tokens[pos - 1] = lastId;
                md.tokenPos[lastId] = pos;
            }
            md.tokens.pop();
            delete md.tokenPos[id];

            $.nft.transferFrom(address(this), msg.sender, id);
        }

        md.staked -= tokenIds.length;
        $.totalStaked -= tokenIds.length;

        if (md.active && md.staked < MIN_ACTIVATION) {
            _removeActive($, msg.sender, md, wasWeight);
            $.totalWeight -= wasWeight;
            emit MinerDeactivated(msg.sender, md.staked);
        } else {
            _syncWeight($, md, wasWeight);
        }

        if (md.staked == 0) {
            // 从 minerList swap-remove
            uint256 idx = md.listIndex;
            uint256 lastIdx = $.minerList.length - 1;
            address lastMiner = $.minerList[lastIdx];
            if (idx != lastIdx) {
                $.minerList[idx] = lastMiner;
                $.miners[lastMiner].listIndex = idx;
            }
            $.minerList.pop();
            md.listIndex = 0;
        }

        emit Unstaked(msg.sender, tokenIds.length, md.staked, tokenIds);
    }

    /// @notice 激活为出块候选矿工（要求质押 ≥ MIN_ACTIVATION，且未达容量上限）
    function activate() external {
        PoolStorage storage $ = _s();
        MinerData storage md = $.miners[msg.sender];
        if (md.active) revert AlreadyActive();
        if (md.staked < MIN_ACTIVATION) revert BelowActivationThreshold(md.staked, MIN_ACTIVATION);
        if ($.activeList.length >= FEN_CAPACITY) revert CapacityExceeded();

        md.active = true;
        md.activeIndex = $.activeList.length;
        $.activeList.push(msg.sender);

        uint256 w = weightFor(md.staked);
        $.totalWeight += w;
        _fenAdd($, md.activeIndex + 1, int256(w));
        emit MinerActivated(msg.sender, md.staked, w);
    }

    /// @notice 主动退出出块候选集（NFT 保持质押，可再次 activate）
    function deactivate() external {
        PoolStorage storage $ = _s();
        MinerData storage md = $.miners[msg.sender];
        if (!md.active) revert NotActive();
        uint256 w = weightFor(md.staked);
        $.totalWeight -= w;
        _removeActive($, msg.sender, md, w);
        emit MinerDeactivated(msg.sender, md.staked);
    }

    // ---------------------------------------------------------------- 内部：Fenwick 树

    /// @dev 1-indexed 点更新。固定传播到 FEN_CAPACITY（而非当前 activeList 长度），
    ///      保证后续 append（activate 入列）时上层节点已含正确部分和。
    function _fenAdd(PoolStorage storage $, uint256 i, int256 delta) private {
        for (uint256 j = i; j <= FEN_CAPACITY; j += j & (~j + 1)) {
            $.fen[j] = uint256(int256($.fen[j]) + delta);
        }
    }

    /// @dev 前缀和下降：找最小 idx 使 prefix(idx) > r，返回 0-based activeList 下标。
    ///      调用方保证 r < totalWeight。固定 17 层 ⇒ 17 次 SLOAD。
    function _fenFind(PoolStorage storage $, uint256 r) private view returns (uint256) {
        uint256 pos;
        for (uint256 mask = FEN_CAPACITY; mask > 0; mask >>= 1) {
            uint256 next = pos + mask;
            if (next <= FEN_CAPACITY) {
                uint256 v = $.fen[next];
                if (v <= r) {
                    r -= v;
                    pos = next;
                }
            }
        }
        return pos; // 1-indexed 答案为 pos + 1，转 0-based 即 pos
    }

    // ---------------------------------------------------------------- 内部：簿记

    /// @dev staked 变化后同步 totalWeight 与树（仅激活矿工计入分母）
    function _syncWeight(PoolStorage storage $, MinerData storage md, uint256 wasWeight) private {
        if (md.active) {
            uint256 nw = weightFor(md.staked);
            $.totalWeight = $.totalWeight - wasWeight + nw;
            _fenAdd($, md.activeIndex + 1, int256(nw) - int256(wasWeight));
        }
    }

    /// @dev activeList swap-remove，并同步 Fenwick 树：清掉被移除者权重、
    ///      把队尾矿工的权重从 lastIdx 搬到 idx。
    ///      removedWeight 必须由调用方传入：unstake 自动失活路径里 md.staked
    ///      已先被扣减，函数内重算会得到错误的（更小的）权重。
    function _removeActive(PoolStorage storage $, address miner, MinerData storage md, uint256 removedWeight)
        private
    {
        uint256 idx = md.activeIndex;
        uint256 lastIdx = $.activeList.length - 1;
        _fenAdd($, idx + 1, -int256(removedWeight));
        if (idx != lastIdx) {
            address last = $.activeList[lastIdx];
            uint256 lastW = weightFor($.miners[last].staked);
            _fenAdd($, lastIdx + 1, -int256(lastW));
            _fenAdd($, idx + 1, int256(lastW));
            $.activeList[idx] = last;
            $.miners[last].activeIndex = idx;
        }
        $.activeList.pop();
        md.active = false;
        md.activeIndex = 0;
        // miner 仅用于事件语境，保持签名整洁
        miner;
    }

    // ---------------------------------------------------------------- 读接口（前端 / 扫链）

    function nft() external view returns (address) {
        return address(_s().nft);
    }

    function fallbackAddress() external view returns (address) {
        return _s().fallbackAddress;
    }

    /// @notice 加权随机的分母：所有激活矿工 weight 之和
    function totalWeight() external view returns (uint256) {
        return _s().totalWeight;
    }

    /// @notice Fenwick 树根节点（全树权重和）。运维校验用：应恒等于 totalWeight()。
    function fenTotal() external view returns (uint256) {
        return _s().fen[FEN_CAPACITY];
    }

    function totalStaked() external view returns (uint256) {
        return _s().totalStaked;
    }

    function stakerOf(uint256 tokenId) external view returns (address) {
        return _s().stakerOf_[tokenId];
    }

    /// @notice 矿工聚合信息（weight 为按当前质押量计算的潜在权重；是否计入分母看 active）
    function minerInfo(address miner)
        external
        view
        returns (uint256 staked, bool active, uint256 multiplierBps, uint256 weight)
    {
        MinerData storage md = _s().miners[miner];
        staked = md.staked;
        active = md.active;
        multiplierBps = multiplierBpsFor(staked);
        weight = weightFor(staked);
    }

    /// @notice 矿工潜在权重（= weightFor(staked)，未激活也返回，供前端展示）
    function minerWeight(address miner) external view returns (uint256) {
        return weightFor(_s().miners[miner].staked);
    }

    function minerCount() external view returns (uint256) {
        return _s().minerList.length;
    }

    function minerAt(uint256 index) external view returns (address) {
        return _s().minerList[index];
    }

    function activeMinerCount() external view returns (uint256) {
        return _s().activeList.length;
    }

    function activeMinerAt(uint256 index) external view returns (address) {
        return _s().activeList[index];
    }

    /// @notice 分页读取激活矿工列表
    function activeMinersPage(uint256 offset, uint256 limit) external view returns (address[] memory page) {
        address[] storage list = _s().activeList;
        uint256 len = list.length;
        if (offset >= len) return new address[](0);
        uint256 n = len - offset;
        if (n > limit) n = limit;
        page = new address[](n);
        for (uint256 i; i < n; ++i) page[i] = list[offset + i];
    }

    /// @notice 分页读取某矿工质押中的 tokenId（前端 unstake 选取用）
    function stakedTokensPage(address miner, uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory page)
    {
        uint256[] storage list = _s().miners[miner].tokens;
        uint256 len = list.length;
        if (offset >= len) return new uint256[](0);
        uint256 n = len - offset;
        if (n > limit) n = limit;
        page = new uint256[](n);
        for (uint256 i; i < n; ++i) page[i] = list[offset + i];
    }
}

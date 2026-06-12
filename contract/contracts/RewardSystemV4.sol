// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/// @title RewardSystemV4 — Meta Assets Chain POCC 矿池（RewardSystemV3 的 UUPS 升级实现）
/// @notice 链端每块通过受限 gas（100k）的 StaticCall 读取本合约：
///         `rewardForBlock(height)` 决定产量（保持 1e18 = 1 MA），
///         `sweepAddress()` 在激活矿工间按权重加权随机，返回本块奖励/手续费归集地址。
///         虚拟矿池：只计算、不记账、不持有奖励资金。
/// @dev    solc 0.8.24 / OZ 5.0.2，与链上 V1/V2/V3 一致；ERC-7201 命名空间存储。
///
///         === V4 变更：延迟一块生效（防"质押时序操纵"，对应安全审计 C-1 路径 3） ===
///         背景：链端在【本块所有交易执行之后】的状态上调用 `sweepAddress()` 决定本块归属，
///         而随机种子 `keccak256(N ‖ blockhash(N-1))` 在第 N 块开始前就公开可算。于是一个
///         【纯矿工】（非出块者）只要让一笔 stake/unstake/activate/deactivate 落进第 N 块，
///         就能改动第 N 块自己用的 totalWeight / 区间，把中奖挪到自己头上（反应式择时）。
///         链端读取时机无法在合约侧改动，故 V4 改"被读取的状态"：
///         **任何权重/激活变更对选择的影响延迟一个区块生效。** 落在第 N 块的变更，
///         第 N 块的 `sweepAddress()` 视而不见，自第 N+1 块起才计入。攻击者既改不动正在
///         被决定的那一块，又无法预测下一块的种子（`blockhash(N)` 此刻未定），择时攻击失效。
///         （路径 2 —— 出块者碾磨 blockhash —— 需链层 VRF，不在纯合约范围；威胁模型中
///         validator 为可信内部。）
///
///         实现：在 V3 的 Fenwick 树之外新建一棵【节点版本化】的延迟树 `dfen`，每个节点
///         打包三段 `value | prev | stamp`（96+96+64 bit，恰好一个槽，读仍是单 SLOAD）：
///           - value：该节点当前（live）部分和；
///           - prev ：该节点在 stamp 所记区块【之前】的部分和；
///           - stamp：该节点最近一次被修改的区块号。
///         只读取值规则：`effective = (stamp == block.number) ? prev : value`。
///         于是【本块内的修改】对选择不可见（用 prev），且【过块后自动成熟】（stamp<当前块
///         即用 value），无需任何"刷新"交易——空块也能正确成熟。
///
///         === 永久位置（放弃 swap-remove） ===
///         V3 的 Fenwick 按 activeList 下标编址并在失活时 swap-remove 压缩数组。延迟生效下，
///         "数组立刻压缩"与"树延迟读取"会错位（读到越界或张冠李戴）。V4 改为【永久位置】：
///         每个矿工首次激活分配一个永不移动的位置，失活只把其权重清零（保留位置），再次激活
///         复用原位置。activeList 因而只增不删（含失活占位），`activeMinerCount/At/Page`
///         改为按 live `active` 过滤。位置上限仍为 FEN_CAPACITY（按"历史去重矿工数"计）。
///
///         存储仅在 PoolStorage 末尾【追加】，V1/V2/V3 字段一字未动，布局兼容；`fen`（V3 树）
///         在 V4 中冻结不再使用。父合约初始化已在 V1 完成，V4 仅需 reinitializer(4) 的
///         initializeV4 —— 因此豁免插件的 missing-initializer 误报。
/// @custom:oz-upgrades-unsafe-allow missing-initializer
contract RewardSystemV4 is Initializable, UUPSUpgradeable, OwnableUpgradeable {
    // ---------------------------------------------------------------- 常量

    /// @notice 激活矿工的最低质押数量（权重门槛 100）
    uint256 public constant MIN_ACTIVATION = 100;
    /// @notice 权重定点系数：算力 CU = weight / WEIGHT_SCALE
    uint256 public constant WEIGHT_SCALE = 10000;
    /// @notice 永久位置容量上限 = Fenwick 树固定规模（2^16，树深 17 层）
    uint256 public constant FEN_CAPACITY = 65536;

    uint256 private constant TIER2_COUNT = 600; // ≥600 → 1.05x
    uint256 private constant TIER3_COUNT = 6000; // ≥6000 → 1.15x（封顶档）
    uint256 private constant TIER1_BPS = 10000;
    uint256 private constant TIER2_BPS = 10500;
    uint256 private constant TIER3_BPS = 11500;

    // 打包字段位宽：value(0..95) | prev(96..191) | stamp(192..255)
    uint256 private constant MASK96 = (1 << 96) - 1;

    // ---------------------------------------------------------------- 存储

    struct MinerData {
        uint256 staked; // 已质押 MST 数量
        bool active; // 是否在出块候选集（live）
        uint256 listIndex; // 在 minerList 中的下标
        uint256 activeIndex; // V3 遗留字段（V4 不再使用，永久位置见 posOf1）
        uint256[] tokens; // 质押中的 tokenId 列表
        mapping(uint256 => uint256) tokenPos; // tokenId => tokens 下标 + 1
    }

    /// @custom:storage-location erc7201:machain.storage.RewardPool
    struct PoolStorage {
        // ↓↓↓ V1/V2 既有字段，顺序与类型禁止改动 ↓↓↓
        IERC721 nft;
        address fallbackAddress;
        uint256 totalWeight; // 所有激活矿工权重之和（live 分母，供前端展示）
        uint256 totalStaked;
        address[] minerList;
        address[] activeList; // V4：永久位置数组（position => miner），只增不删（含失活占位）
        mapping(address => MinerData) miners;
        mapping(uint256 => address) stakerOf_;
        // ↓↓↓ V3 追加（V4 中冻结不用） ↓↓↓
        mapping(uint256 => uint256) fen;
        // ↓↓↓ V4 追加 ↓↓↓
        // 延迟生效 Fenwick 树，1-indexed，节点打包 value|prev|stamp（见文件头说明）。
        mapping(uint256 => uint256) dfen;
        // 矿工的永久位置（1-indexed，0 = 从未分配）。
        mapping(address => uint256) posOf1;
        // 当前 live 激活矿工数（activeList 含失活占位，故单独维护）。
        uint256 activeCountLive;
    }

    // keccak256(abi.encode(uint256(keccak256("machain.storage.RewardPool")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant POOL_STORAGE_LOCATION =
        0xb58d6ebea3fe050b335ec9e23b86a3b1c6750142428039386b2ba5577aeb4a00;

    function _s() private pure returns (PoolStorage storage $) {
        assembly {
            $.slot := POOL_STORAGE_LOCATION
        }
    }

    // ---------------------------------------------------------------- 事件（miner 均 indexed）

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
    error WeightOverflow();

    // ---------------------------------------------------------------- 初始化 / 升级

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice V3 → V4 升级后的一次性初始化：把现存激活矿工灌入延迟树 dfen 并分配永久位置。
    /// @dev    必须与升级同笔执行（upgradeToAndCall）。迁移当块所有 dfen 节点 stamp = 升级块，
    ///         故【升级块当块】selection 读到 prev=0 → 视为空 → 链端回退 fallback（与 V3
    ///         initializeV3 的原子升级语义一致）；下一块即自动成熟恢复正常。
    ///         沿用 V3 的 activeList（其在 V3 中为紧凑全激活），位置 i 即矿工的永久位置。
    function initializeV4() external reinitializer(4) onlyOwner {
        PoolStorage storage $ = _s();
        uint256 len = $.activeList.length;
        if (len > FEN_CAPACITY) revert CapacityExceeded();
        uint256 live;
        for (uint256 i; i < len; ++i) {
            address m = $.activeList[i];
            MinerData storage md = $.miners[m];
            $.posOf1[m] = i + 1;
            if (md.active) {
                _dfenAdd($, i + 1, int256(weightFor(md.staked)));
                ++live;
            }
        }
        $.activeCountLive = live;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    // ---------------------------------------------------------------- 管理

    /// @notice 设置 MST 合约。仅允许在池内无存量质押时调用（避免旧 NFT 永久滞留）。
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

    /// @notice 本高度奖励/手续费归集地址。基于【上一块末尾】的激活权重做加权随机
    ///         （本块内的任何变更不计入——延迟一块生效）。无（已成熟的）激活权重时返回 fallback。
    /// @dev    selector 与 V1/V2/V3 一致，链端调用方零改动。延迟树下降固定 ≤17 次 SLOAD。
    function sweepAddress() external view returns (address) {
        PoolStorage storage $ = _s();
        uint256 tw = _dfenEffective($, FEN_CAPACITY); // 成熟（上一块末）的总权重
        if (tw == 0) return $.fallbackAddress;

        (, bytes32 seed) = currentSeed();
        return $.activeList[_dfenFind($, uint256(seed) % tw)];
    }

    /// @notice 出块随机源：当前区块高度 + 上一块哈希。同一高度内确定，跨高度变化。
    function currentSeed() public view returns (uint256 blockNumber, bytes32 seed) {
        blockNumber = block.number;
        seed = keccak256(abi.encodePacked(block.number, blockhash(block.number - 1)));
    }

    // ---------------------------------------------------------------- 段位 / 权重（纯函数）

    function multiplierBpsFor(uint256 stakedCount) public pure returns (uint256) {
        if (stakedCount >= TIER3_COUNT) return TIER3_BPS;
        if (stakedCount >= TIER2_COUNT) return TIER2_BPS;
        return TIER1_BPS;
    }

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
            // 自动失活：从延迟树清掉失活前的完整权重（保留永久位置）
            md.active = false;
            $.activeCountLive -= 1;
            $.totalWeight -= wasWeight;
            _dfenAdd($, _posOf($, msg.sender), -int256(wasWeight));
            emit MinerDeactivated(msg.sender, md.staked);
        } else {
            _syncWeight($, md, wasWeight);
        }

        if (md.staked == 0) {
            // 从 minerList（全体质押者）swap-remove —— 与永久位置无关，可安全压缩
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

    /// @notice 激活为出块候选矿工（要求质押 ≥ MIN_ACTIVATION）。首次激活分配永久位置，
    ///         再次激活复用原位置。
    function activate() external {
        PoolStorage storage $ = _s();
        MinerData storage md = $.miners[msg.sender];
        if (md.active) revert AlreadyActive();
        if (md.staked < MIN_ACTIVATION) revert BelowActivationThreshold(md.staked, MIN_ACTIVATION);

        uint256 pos1 = $.posOf1[msg.sender];
        if (pos1 == 0) {
            // 分配永久位置（append，永不回收/移动）
            if ($.activeList.length >= FEN_CAPACITY) revert CapacityExceeded();
            $.activeList.push(msg.sender);
            pos1 = $.activeList.length; // 1-indexed
            $.posOf1[msg.sender] = pos1;
        }

        md.active = true;
        $.activeCountLive += 1;
        uint256 w = weightFor(md.staked);
        $.totalWeight += w;
        _dfenAdd($, pos1, int256(w));
        emit MinerActivated(msg.sender, md.staked, w);
    }

    /// @notice 主动退出出块候选集（NFT 保持质押，可再次 activate，复用原位置）
    function deactivate() external {
        PoolStorage storage $ = _s();
        MinerData storage md = $.miners[msg.sender];
        if (!md.active) revert NotActive();
        uint256 w = weightFor(md.staked);
        md.active = false;
        $.activeCountLive -= 1;
        $.totalWeight -= w;
        _dfenAdd($, _posOf($, msg.sender), -int256(w));
        emit MinerDeactivated(msg.sender, md.staked);
    }

    // ---------------------------------------------------------------- 内部：延迟生效 Fenwick 树

    function _posOf(PoolStorage storage $, address miner) private view returns (uint256) {
        return $.posOf1[miner]; // 调用点保证已分配（active 路径）
    }

    /// @dev 1-indexed 点更新，固定传播到 FEN_CAPACITY。每个节点按"本块首次触碰即把 value
    ///      存入 prev、记 stamp"维护版本，使只读时可还原"上一块末"的值。
    function _dfenAdd(PoolStorage storage $, uint256 i, int256 delta) private {
        uint256 bn = block.number;
        for (uint256 j = i; j <= FEN_CAPACITY; j += j & (~j + 1)) {
            uint256 node = $.dfen[j];
            uint256 v = node & MASK96;
            uint256 p = (node >> 96) & MASK96;
            uint256 s = node >> 192;
            if (s != bn) {
                p = v; // 本块首次修改：旧 value 即"上一块末"的值，存为 prev
                s = bn;
            }
            int256 nv = int256(v) + delta;
            if (nv < 0) revert WeightOverflow(); // 记账保证不发生；防御
            if (uint256(nv) > MASK96) revert WeightOverflow();
            v = uint256(nv);
            $.dfen[j] = v | (p << 96) | (s << 192);
        }
    }

    /// @dev 节点的"成熟"有效值：本块改过则用 prev（上一块末），否则用 value（已成熟）。
    function _dfenEffective(PoolStorage storage $, uint256 j) private view returns (uint256) {
        uint256 node = $.dfen[j];
        if ((node >> 192) == block.number) return (node >> 96) & MASK96; // prev
        return node & MASK96; // value
    }

    /// @dev 前缀和下降：找最小 idx 使 effectivePrefix(idx) > r，返回 0-based 位置。
    ///      调用方保证 r < 成熟总权重。固定 17 层 ⇒ ≤17 次 SLOAD。
    function _dfenFind(PoolStorage storage $, uint256 r) private view returns (uint256) {
        uint256 pos;
        for (uint256 mask = FEN_CAPACITY; mask > 0; mask >>= 1) {
            uint256 next = pos + mask;
            if (next <= FEN_CAPACITY) {
                uint256 v = _dfenEffective($, next);
                if (v <= r) {
                    r -= v;
                    pos = next;
                }
            }
        }
        return pos; // 1-indexed 答案为 pos+1，转 0-based 即 pos
    }

    // ---------------------------------------------------------------- 内部：簿记

    /// @dev staked 变化后同步 live totalWeight 与延迟树（仅激活矿工计入分母）
    function _syncWeight(PoolStorage storage $, MinerData storage md, uint256 wasWeight) private {
        if (md.active) {
            uint256 nw = weightFor(md.staked);
            $.totalWeight = $.totalWeight - wasWeight + nw;
            _dfenAdd($, _posOf($, msg.sender), int256(nw) - int256(wasWeight));
        }
    }

    // ---------------------------------------------------------------- 读接口（前端 / 扫链）

    function nft() external view returns (address) {
        return address(_s().nft);
    }

    function fallbackAddress() external view returns (address) {
        return _s().fallbackAddress;
    }

    /// @notice live 加权随机分母（即时反映最新质押，供前端展示）。
    function totalWeight() external view returns (uint256) {
        return _s().totalWeight;
    }

    /// @notice 选择实际使用的分母（延迟生效：上一块末的总权重）。运维/对拍用。
    function selectionTotalWeight() external view returns (uint256) {
        return _dfenEffective(_s(), FEN_CAPACITY);
    }

    /// @notice 延迟树根节点的 live 部分和。运维校验：应恒等于 totalWeight()。
    function fenTotal() external view returns (uint256) {
        return _s().dfen[FEN_CAPACITY] & MASK96;
    }

    function totalStaked() external view returns (uint256) {
        return _s().totalStaked;
    }

    function stakerOf(uint256 tokenId) external view returns (address) {
        return _s().stakerOf_[tokenId];
    }

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

    function minerWeight(address miner) external view returns (uint256) {
        return weightFor(_s().miners[miner].staked);
    }

    function minerCount() external view returns (uint256) {
        return _s().minerList.length;
    }

    function minerAt(uint256 index) external view returns (address) {
        return _s().minerList[index];
    }

    /// @notice 当前 live 激活矿工数（不含失活占位）。
    function activeMinerCount() external view returns (uint256) {
        return _s().activeCountLive;
    }

    /// @notice 第 index 个【live 激活】矿工（跳过失活占位）。O(positionsUsed) 视图。
    function activeMinerAt(uint256 index) external view returns (address) {
        PoolStorage storage $ = _s();
        uint256 len = $.activeList.length;
        uint256 seen;
        for (uint256 i; i < len; ++i) {
            address m = $.activeList[i];
            if ($.miners[m].active) {
                if (seen == index) return m;
                ++seen;
            }
        }
        revert("index out of range");
    }

    /// @notice 分页读取【live 激活】矿工（跳过失活占位）。
    function activeMinersPage(uint256 offset, uint256 limit) external view returns (address[] memory page) {
        PoolStorage storage $ = _s();
        uint256 total = $.activeCountLive;
        if (offset >= total) return new address[](0);
        uint256 n = total - offset;
        if (n > limit) n = limit;
        page = new address[](n);
        uint256 len = $.activeList.length;
        uint256 seen;
        uint256 filled;
        for (uint256 i; i < len && filled < n; ++i) {
            address m = $.activeList[i];
            if (!$.miners[m].active) continue;
            if (seen >= offset) {
                page[filled++] = m;
            }
            ++seen;
        }
    }

    /// @notice 永久位置总数（含失活占位）。运维/测试用：位置只增不减。
    function positionsUsed() external view returns (uint256) {
        return _s().activeList.length;
    }

    /// @notice 永久位置 pos（0-based）上的矿工（可能为失活占位）。越界返回零地址。
    function positionMinerAt(uint256 pos) external view returns (address) {
        PoolStorage storage $ = _s();
        if (pos >= $.activeList.length) return address(0);
        return $.activeList[pos];
    }

    /// @notice 矿工的永久位置（1-indexed，0 = 从未激活）。
    function minerPosition(address miner) external view returns (uint256) {
        return _s().posOf1[miner];
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

// MetaAssets Chain · Pool DApp (H5)
// Mock "on-chain" database and utilities

export const fmt = {
  addr(a) {
    if (!a) return "";
    if (a.length <= 12) return a;
    return `${a.slice(0, 6)}...${a.slice(-4)}`;
  },
  num(n) {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return "--";
    return new Intl.NumberFormat("en-US").format(Number(n));
  },
  pct(v) {
    if (v === null || v === undefined || Number.isNaN(Number(v))) return "--";
    return `${(Number(v) * 100).toFixed(2)}%`;
  },
  dur(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  },
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Mock database
export const mockDB = {
  network: {
    totalPower: 281_420, // CU/s
  },
  wallet: {
    connected: false,
    address: null,
  },
  nfts: [],
  pools: [],
  activity: [],
};

export function seed() {
  // Deterministic-ish seed based on day
  const today = new Date();
  const seedNum = Number(
    `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`
  );
  let x = seedNum % 2147483647;
  const rand = () => (x = (x * 48271) % 2147483647) / 2147483647;

  const owned = 6532;
  const baseId = 120000;
  mockDB.nfts = Array.from({ length: owned }, (_, i) => ({
    id: baseId + i + 1,
    stakedTo: null,
    mintedAt: Date.now() - Math.floor(rand() * 20 * 86400 * 1000),
  }));

  // Create a couple of pools, one boosted
  const pool1 = {
    id: 1024,
    createdAt: Date.now() - 12 * 86400 * 1000,
    status: "running", // running | inactive | deleted
    stakedIds: [],
  };
  const pool2 = {
    id: 2048,
    createdAt: Date.now() - 3.6 * 86400 * 1000,
    status: "inactive",
    stakedIds: [],
  };

  // Stake 6000 to pool1, 100 to pool2
  const ids = mockDB.nfts.map((n) => n.id);
  pool1.stakedIds = ids.slice(0, 6000);
  pool2.stakedIds = ids.slice(6000, 6100);
  const staked = new Set([...pool1.stakedIds, ...pool2.stakedIds]);
  mockDB.nfts.forEach((n) => {
    if (staked.has(n.id)) n.stakedTo = pool1.stakedIds.includes(n.id) ? pool1.id : pool2.id;
  });
  mockDB.pools = [pool1, pool2];

  mockDB.activity = [
    {
      id: "a1",
      type: "Apply Pool",
      status: "confirmed",
      time: Date.now() - 12 * 86400 * 1000,
      tx: "0x9a7d...c1f2",
      detail: "Pool #1024, tier 6000 (1.1x)",
    },
    {
      id: "a2",
      type: "Apply Pool",
      status: "confirmed",
      time: Date.now() - 3.6 * 86400 * 1000,
      tx: "0x2b11...a9e0",
      detail: "Pool #2048, tier 100",
    },
    {
      id: "a3",
      type: "Remove CU",
      status: "failed",
      time: Date.now() - 2.2 * 86400 * 1000,
      tx: "0x5c20...0d8a",
      detail: "Pool #2048, -20 NFTs",
    },
  ];
}

export function persist() {
  try {
    localStorage.setItem(
      "metaassets.pool.h5",
      JSON.stringify({
        wallet: mockDB.wallet,
        pools: mockDB.pools,
        nfts: mockDB.nfts,
        activity: mockDB.activity,
        network: mockDB.network,
      })
    );
  } catch (_) {}
}

export function load() {
  try {
    const raw = localStorage.getItem("metaassets.pool.h5");
    if (!raw) return;
    const s = JSON.parse(raw);
    if (s && s.wallet) mockDB.wallet = s.wallet;
    if (s && s.pools) mockDB.pools = s.pools;
    if (s && s.nfts) mockDB.nfts = s.nfts;
    if (s && s.activity) mockDB.activity = s.activity;
    if (s && s.network) mockDB.network = s.network;
  } catch (_) {}
}

// Business rules
export function tierToPower(tier) {
  if (tier === 100) return { staked: 100, base: 100, boosted: 100, boost: false, coef: 1.0 };
  if (tier === 6000) return { staked: 6000, base: 6000, boosted: 6600, boost: true, coef: 1.1 };
  return { staked: tier, base: tier, boosted: tier, boost: false, coef: 1.0 };
}

export function poolPower(pool) {
  const staked = pool.stakedIds.length;
  const boost = staked >= 6000; // prototype rule: 6000 triggers boost
  const boosted = boost ? Math.floor(staked * 1.1) : staked;
  return { staked, boost, boosted, coef: boost ? 1.1 : 1.0 };
}

export function availableNFTs() {
  return mockDB.nfts.filter((n) => !n.stakedTo);
}

export function stakedNFTs() {
  return mockDB.nfts.filter((n) => !!n.stakedTo);
}

export function nextPoolId() {
  const max = mockDB.pools.reduce((m, p) => Math.max(m, p.id), 1000);
  return max + 7;
}

export function shortenHash(h) {
  if (!h) return "";
  if (h.length <= 14) return h;
  return `${h.slice(0, 6)}...${h.slice(-4)}`;
}

export function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

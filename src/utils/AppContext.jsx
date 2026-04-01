import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { mockDB, seed, load, persist, availableNFTs, stakedNFTs, tierToPower, poolPower, nextPoolId, shortenHash, fmt, sleep } from '../utils/db';

const AppContext = createContext(null);

export function AppProvider({ children }) {
  const [wallet, setWallet] = useState(mockDB.wallet);
  const [toasts, setToasts] = useState([]);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    seed();
    load();
    setWallet({ ...mockDB.wallet });
  }, []);

  const refreshAll = useCallback(() => {
    setRefreshKey(k => k + 1);
  }, []);

  const connect = useCallback(() => {
    mockDB.wallet.connected = true;
    mockDB.wallet.address = "0x12ab34cd56ef7890aaBbCCddEEff001122334455";
    setWallet({ ...mockDB.wallet });
    persist();
    refreshAll();
    addToast("Wallet connected", "You can now manage on-chain pools.", "good");
  }, [refreshAll]);

  const disconnect = useCallback(() => {
    mockDB.wallet.connected = false;
    mockDB.wallet.address = null;
    setWallet({ ...mockDB.wallet });
    persist();
    refreshAll();
    addToast("Wallet disconnected", "Connect again to view your on-chain state.", "warn");
  }, [refreshAll]);

  const addToast = useCallback((title, desc, kind = "default", timeoutMs = 3200) => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, title, desc, kind }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, timeoutMs);
  }, []);

  const removeToast = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const confirmSheet = useCallback(async (title, summaryLines) => {
    return new Promise((resolve) => {
      const ov = document.getElementById("overlay");
      const sheet = document.getElementById("sheet");
      if (!ov || !sheet) return resolve(false);

      const sheetTitle = document.getElementById("sheetTitle");
      const sheetKv = document.getElementById("sheetKv");
      const sheetBodyHint = document.getElementById("sheetBodyHint");
      const sheetPrimary = document.getElementById("sheetPrimary");
      const sheetSecondary = document.getElementById("sheetSecondary");
      const sheetClose = document.getElementById("sheetClose");

      sheetTitle.textContent = title;
      sheetKv.innerHTML = "";
      summaryLines.forEach(([k, v]) => {
        const row = document.createElement("div");
        row.className = "kv";
        row.innerHTML = `<div class="k">${escapeHtml(k)}</div><div class="v mono">${escapeHtml(v)}</div>`;
        sheetKv.appendChild(row);
      });

      sheetPrimary.textContent = "Confirm & Sign";
      sheetSecondary.textContent = "Cancel";
      sheetBodyHint.textContent = "Review the on-chain effects before you sign.";

      const close = (val) => {
        ov.classList.remove("show");
        sheet.style.display = "none";
        cleanup();
        resolve(val);
      };

      const onOv = (e) => {
        if (e.target === ov) close(false);
      };
      const onOk = () => close(true);
      const onCancel = () => close(false);

      const cleanup = () => {
        ov.removeEventListener("click", onOv);
        sheetPrimary.removeEventListener("click", onOk);
        sheetSecondary.removeEventListener("click", onCancel);
        sheetClose.removeEventListener("click", onCancel);
      };

      ov.classList.add("show");
      sheet.style.display = "block";

      ov.addEventListener("click", onOv);
      sheetPrimary.addEventListener("click", onOk);
      sheetSecondary.addEventListener("click", onCancel);
      sheetClose.addEventListener("click", onCancel);
    });
  }, []);

  const txSheet = useCallback(async (title, desc, meta = {}) => {
    const ov = document.getElementById("overlayTx");
    const sheet = document.getElementById("sheetTx");
    if (!ov || !sheet) return;

    const txTitle = document.getElementById("txTitle");
    const txDesc = document.getElementById("txDesc");
    const txHash = document.getElementById("txHash");
    const txStage = document.getElementById("txStage");
    const txLink = document.getElementById("txLink");
    const txPrimary = document.getElementById("txPrimary");

    txTitle.textContent = title;
    txDesc.textContent = desc;
    txHash.textContent = meta.hash ? shortenHash(meta.hash) : "--";
    txStage.textContent =
      meta.stage === 1
        ? "Awaiting signature"
        : meta.stage === 2
          ? "Submitting"
          : meta.stage === 3
            ? "Confirming"
            : meta.stage === "success"
              ? "Success"
              : meta.stage === "fail"
                ? "Failed"
                : "—";

    txLink.onclick = () => addToast("Explorer link", "Wire explorer URL later.", "warn");

    txPrimary.textContent = meta.stage === "success" || meta.stage === "fail" ? "Done" : "Hide";
    txPrimary.onclick = () => {
      ov.classList.remove("show");
      sheet.style.display = "none";
    };

    ov.classList.add("show");
    sheet.style.display = "block";
  }, [addToast]);

  const runTx = useCallback(async ({ title, summaryLines, onConfirm }) => {
    if (!mockDB.wallet.connected) {
      addToast("Connect wallet first", "This action requires a wallet connection.", "warn");
      return;
    }

    const ok = await confirmSheet(title, summaryLines);
    if (!ok) return;

    // Stage 1
    await txSheet("Awaiting signature…", "Please confirm in your wallet.", { stage: 1 });
    await sleep(650);

    // Stage 2
    const hash = `0x${Math.random().toString(16).slice(2).padEnd(64, "0").slice(0, 64)}`;
    await txSheet("Submitting transaction…", "Transaction broadcasted to the network.", {
      stage: 2,
      hash,
    });
    await sleep(700);

    // Stage 3
    const confirmations = 12;
    for (let c = 1; c <= confirmations; c++) {
      await txSheet("Confirming on-chain…", `Confirmations: ${c}/${confirmations}`, {
        stage: 3,
        hash,
        confirmations: { c, confirmations },
      });
      await sleep(140);
    }

    // Random-ish outcome (mostly success)
    const failed = Math.random() < 0.12;
    if (failed) {
      await txSheet("Transaction failed", "Reverted by EVM (simulated).", { stage: "fail", hash });
      addToast("Transaction failed", "Nothing changed on-chain.", "bad");
      refreshAll();
      return;
    }

    if (typeof onConfirm === "function") onConfirm({ hash });
    persist();

    await txSheet("Transaction confirmed", "On-chain state updated.", { stage: "success", hash });
    addToast("Transaction confirmed", "Your pools and NFTs are updated.", "good");
    refreshAll();
  }, [confirmSheet, txSheet, addToast, refreshAll]);

  const applyPool = useCallback(async (tier) => {
    const calc = tierToPower(tier);
    const available = availableNFTs().length;

    await runTx({
      title: "Confirm Pool Application",
      summaryLines: [
        ["Tier", tier === 6000 ? "6000 (Boost 1.1x)" : "100"],
        ["Staking", `${fmt.num(calc.staked)} NFTs`],
        ["Expected Power", `${fmt.num(calc.boosted)} CU/s`],
      ],
      onConfirm: ({ hash }) => {
        const ids = availableNFTs()
          .slice(0, calc.staked)
          .map((n) => n.id);
        const pid = nextPoolId();
        mockDB.pools.unshift({
          id: pid,
          createdAt: Date.now(),
          status: "running",
          stakedIds: ids,
        });
        mockDB.nfts.forEach((n) => {
          if (ids.includes(n.id)) n.stakedTo = pid;
        });
        mockDB.activity.unshift({
          id: `act_${Date.now()}`,
          type: "Apply Pool",
          status: "confirmed",
          time: Date.now(),
          tx: shortenHash(hash),
          detail: `Pool #${pid}, tier ${tier}${tier === 6000 ? " (1.1x)" : ""}`,
        });
      },
    });
  }, [runTx]);

  const addToPool = useCallback(async (poolId) => {
    const pool = mockDB.pools.find((p) => p.id === poolId);
    if (!pool) return;
    const avail = availableNFTs().length;
    if (avail <= 0) {
      addToast("No available NFTs", "All CapacityUnits are currently staked.", "warn");
      return;
    }
    const addCount = Math.min(100, avail);
    await runTx({
      title: `Add CapacityUnits`,
      summaryLines: [
        ["Pool", `#${poolId}`],
        ["Add", `${fmt.num(addCount)} NFTs (auto)`],
        ["Power change", `+${fmt.num(addCount)} CU/s (base)`],
        ["Note", "Boost may change if staking crosses 6000."],
      ],
      onConfirm: ({ hash }) => {
        const ids = availableNFTs().slice(0, addCount).map((n) => n.id);
        pool.stakedIds.push(...ids);
        mockDB.nfts.forEach((n) => {
          if (ids.includes(n.id)) n.stakedTo = poolId;
        });
        mockDB.activity.unshift({
          id: `act_${Date.now()}`,
          type: "Add CU",
          status: "confirmed",
          time: Date.now(),
          tx: shortenHash(hash),
          detail: `Pool #${poolId}, +${addCount} NFTs`,
        });
      },
    });
  }, [runTx, addToast]);

  const removeFromPool = useCallback(async (poolId) => {
    const pool = mockDB.pools.find((p) => p.id === poolId);
    if (!pool) return;
    if (pool.stakedIds.length === 0) {
      addToast("Nothing to remove", "This pool has no staked NFTs.", "warn");
      return;
    }
    const removeCount = Math.min(20, pool.stakedIds.length);
    const sample = pool.stakedIds.slice(0, Math.min(5, removeCount)).join(", ");
    await runTx({
      title: `Remove CapacityUnits`,
      summaryLines: [
        ["Pool", `#${poolId}`],
        ["Remove", `${fmt.num(removeCount)} NFTs`],
        ["NFT IDs", removeCount > 5 ? `${sample}, …` : sample],
        ["Power change", `-${fmt.num(removeCount)} CU/s (base)`],
      ],
      onConfirm: ({ hash }) => {
        const ids = pool.stakedIds.splice(0, removeCount);
        mockDB.nfts.forEach((n) => {
          if (ids.includes(n.id)) n.stakedTo = null;
        });
        mockDB.activity.unshift({
          id: `act_${Date.now()}`,
          type: "Remove CU",
          status: "confirmed",
          time: Date.now(),
          tx: shortenHash(hash),
          detail: `Pool #${poolId}, -${removeCount} NFTs`,
        });
      },
    });
  }, [runTx, addToast]);

  const deletePool = useCallback(async (poolId) => {
    const pool = mockDB.pools.find((p) => p.id === poolId);
    if (!pool) return;
    const count = pool.stakedIds.length;
    await runTx({
      title: "Delete Pool",
      summaryLines: [
        ["Pool", `#${poolId}`],
        ["Unstake", `${fmt.num(count)} NFTs back to vault`],
        ["Warning", "This is a destructive action (prototype)."],
      ],
      onConfirm: ({ hash }) => {
        const ids = new Set(pool.stakedIds);
        mockDB.nfts.forEach((n) => {
          if (ids.has(n.id)) n.stakedTo = null;
        });
        pool.stakedIds = [];
        pool.status = "deleted";
        mockDB.activity.unshift({
          id: `act_${Date.now()}`,
          type: "Delete Pool",
          status: "confirmed",
          time: Date.now(),
          tx: shortenHash(hash),
          detail: `Pool #${poolId}, unstaked ${count} NFTs`,
        });
      },
    });
  }, [runTx]);

  const value = {
    wallet,
    mockDB,
    toasts,
    refreshKey,
    connect,
    disconnect,
    addToast,
    removeToast,
    confirmSheet,
    txSheet,
    runTx,
    applyPool,
    addToPool,
    removeFromPool,
    deletePool,
    refreshAll,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error("useApp must be used within AppProvider");
  }
  return context;
}

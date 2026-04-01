import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import Layout from '../components/Layout';
import { useApp } from '../utils/AppContext';
import { fmt, poolPower, tierToPower, availableNFTs } from '../utils/db';

function EmptyState({ desc, cta, onClick }) {
  return (
    <div className="card">
      <div className="card-inner">
        <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
          <div className="brand-badge" style={{ width: '42px', height: '42px', borderRadius: '16px' }}></div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: '600', letterSpacing: '.2px' }}>Empty state</div>
            <div className="muted" style={{ marginTop: '6px', fontSize: '13px', lineHeight: '1.4' }}>{desc}</div>
            <button className="btn btn-primary" onClick={onClick} style={{ marginTop: '12px' }}>{cta}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Pools() {
  const { mockDB, refreshKey, connect, applyPool, addToPool, removeFromPool, deletePool } = useApp();
  const [activeTab, setActiveTab] = useState('apply');
  const [activeTier, setActiveTier] = useState(100);
  const [applyMode, setApplyMode] = useState('auto');

  const pools = mockDB.pools.filter((p) => p.status !== "deleted");
  const available = availableNFTs().length;
  const calc = tierToPower(activeTier);

  const handleApply = () => {
    applyPool(activeTier);
  };

  const handleTab = (tab) => {
    setActiveTab(tab);
  };

  const handleTier = (tier) => {
    setActiveTier(tier);
  };

  return (
    <Layout currentPage="pools">
      <section className="hero">
        <div className="hero-title">
          <div>
            <h1>Pools</h1>
            <p className="sub">Stake CapacityUnit NFTs to apply and manage smart-contract pools.</p>
          </div>
          <Link className="btn btn-ghost btn-sm" to="/vault">NFT Vault</Link>
        </div>

        <div className="tabs" style={{ marginTop: '12px' }}>
          <div className={`tab ${activeTab === 'apply' ? 'active' : ''}`} onClick={() => handleTab('apply')}>Apply</div>
          <div className={`tab ${activeTab === 'mine' ? 'active' : ''}`} onClick={() => handleTab('mine')}>My Pools</div>
        </div>
      </section>

      {/* Gate message for not connected */}
      {!mockDB.wallet.connected && (
        <section className="section">
          <div className="overlay" id="poolsGate" style={{ position: 'relative', display: 'block', background: 'transparent' }}>
            <div className="card">
              <div className="card-inner">
                <div className="row">
                  <div>
                    <div style={{ fontWeight: '600' }}>Wallet required</div>
                    <div className="muted" style={{ marginTop: '6px', fontSize: '13px', lineHeight: '1.35' }}>
                      Connect your wallet to load on-chain pools and NFT balances.
                    </div>
                  </div>
                  <button className="btn btn-primary" onClick={connect}>Connect</button>
                </div>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Apply pane */}
      <section className="section tabpane" data-pane="apply" style={{ display: activeTab === 'apply' ? 'block' : 'none' }}>
        <div className="section-title">
          <h2>Staking Tiers</h2>
          <span className="hint">Two fixed tiers</span>
        </div>
        <div className="rule">
          <div style={{ fontWeight: '600' }}>Rules</div>
          <ul>
            <li><strong><span className="mono">100</span></strong> CapacityUnits → <strong><span className="mono">100 CU/s</span></strong></li>
            <li>
              <strong><span className="mono">6000</span></strong> CapacityUnits → triggers <strong><span className="mono">1.1x</span></strong> coefficient:
              <strong><span className="mono">6000 × 1.1 = 6600 CU/s</span></strong>
            </li>
            <li>Each CapacityUnit is a unique NFT ID. Staking maps NFTs to a Pool on-chain.</li>
          </ul>
        </div>

        <div className="section-title" style={{ marginTop: '14px' }}>
          <h2>Select tier</h2>
          <span className="hint">Instant power preview</span>
        </div>
        <div className="tier">
          <button className={`tier-btn ${activeTier === 100 ? 'active' : ''}`} data-tier="100" onClick={() => handleTier(100)}>
            <strong>Tier 100</strong>
            <span>Stake 100 NFTs → 100 CU/s</span>
          </button>
          <button className={`tier-btn ${activeTier === 6000 ? 'active' : ''}`} data-tier="6000" onClick={() => handleTier(6000)}>
            <strong>Tier 6000 (Boost)</strong>
            <span>Stake 6000 NFTs → 6600 CU/s</span>
          </button>
        </div>

        <div className="section-title" style={{ marginTop: '14px' }}>
          <h2>Preview</h2>
          <span className="hint">What you sign</span>
        </div>
        <div className="card">
          <div className="card-inner">
            <div className="kv">
              <div className="k">Staking NFTs</div>
              <div className="v mono" id="apStake">{fmt.num(calc.staked)}</div>
            </div>
            <div className="kv">
              <div className="k">Estimated pool power</div>
              <div className="v mono" id="apPower">{fmt.num(calc.boosted)} CU/s</div>
            </div>
            <div className="kv">
              <div className="k">Boost</div>
              <div className="v mono" id="apBoost">{calc.boost ? "Activated (1.1x)" : "Not activated"}</div>
            </div>
            <div className="kv">
              <div className="k">Available CapacityUnits</div>
              <div className="v mono" id="apAvail">{fmt.num(available)}</div>
            </div>
            <div className="kv">
              <div className="k">NFT selection</div>
              <div className="v mono" id="apMode">{applyMode === "auto" ? "Auto-select (recommended)" : "Manual select (advanced)"}</div>
            </div>

            <div style={{ marginTop: '12px' }}>
              <label className="muted" style={{ display: 'block', fontSize: '12px', marginBottom: '8px' }}>Selection mode</label>
              <select
                id="applyMode"
                value={applyMode}
                onChange={(e) => setApplyMode(e.target.value)}
              >
                <option value="auto" selected>Auto-select NFTs (recommended)</option>
                <option value="manual">Manual select (advanced)</option>
              </select>
              <div className="muted" style={{ marginTop: '8px', fontSize: '12px', lineHeight: '1.35' }}>
                Manual selection is supported via the Vault in a real build. This prototype uses auto-selection.
              </div>
            </div>

            <div style={{ marginTop: '14px' }}>
              <button
                className="btn btn-primary btn-block"
                id="applyBtn"
                onClick={handleApply}
                disabled={available < calc.staked}
              >
                {available >= calc.staked ? "Apply for Pool" : "Insufficient NFTs"}
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* My pools pane */}
      <section className="section tabpane" data-pane="mine" style={{ display: activeTab === 'mine' ? 'block' : 'none' }}>
        <div className="section-title">
          <h2>My Pools</h2>
          <span className="hint">Add / remove / delete</span>
        </div>
        <div className="list" id="myPoolsManageList">
          {!mockDB.wallet.connected ? (
            <EmptyState desc="Connect wallet to manage your pools." cta="Connect Wallet" onClick={connect} />
          ) : pools.length === 0 ? (
            <EmptyState desc="No pools yet. Apply in the Apply tab." cta="Go to Apply" onClick={() => handleTab('apply')} />
          ) : (
            pools.map(p => {
              const pow = poolPower(p);
              const status = p.status === "running"
                ? <span className="tag tag-good">Running</span>
                : p.status === "inactive"
                  ? <span className="tag tag-warn">Inactive</span>
                  : <span className="tag">Unknown</span>;
              const boost = pow.boost ? <span className="tag tag-good">Boost 1.1x</span> : <span className="tag">No boost</span>;

              return (
                <div key={p.id} className="pool-card">
                  <div className="pool-top">
                    <div>
                      <div className="pool-id">Pool #<span className="mono">{p.id}</span></div>
                      <div style={{ marginTop: '8px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                        {status}
                        {boost}
                      </div>
                    </div>
                    <div className="actions">
                      <button className="btn btn-sm btn-primary" onClick={() => window.location.href = `/pool/vault#pool=${p.id}`}>Manage</button>
                      <button className="btn btn-sm btn-ghost" onClick={() => addToPool(p.id)}>Add</button>
                      <button className="btn btn-sm btn-ghost" onClick={() => removeFromPool(p.id)}>Remove</button>
                      <button className="btn btn-sm btn-danger" onClick={() => deletePool(p.id)}>Delete</button>
                    </div>
                  </div>
                  <div className="pool-stats">
                    <div className="mini">
                      <div className="label">Power</div>
                      <div className="value mono">{fmt.num(pow.boosted)} CU/s</div>
                    </div>
                    <div className="mini">
                      <div className="label">Staked NFTs</div>
                      <div className="value mono">{fmt.num(pow.staked)}</div>
                    </div>
                    <div className="mini">
                      <div className="label">Coefficient</div>
                      <div className="value mono">{pow.coef.toFixed(1)}x</div>
                    </div>
                    <div className="mini">
                      <div className="label">Uptime</div>
                      <div className="value mono">{fmt.dur(Date.now() - p.createdAt)}</div>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>
    </Layout>
  );
}

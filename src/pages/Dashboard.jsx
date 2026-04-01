import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import Layout from '../components/Layout';
import { useApp } from '../utils/AppContext';
import { fmt, poolPower, availableNFTs, stakedNFTs } from '../utils/db';

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

function PoolCard({ pool, onManage, onViewNfts, total }) {
  const pow = poolPower(pool);
  const share = total > 0 ? pow.boosted / total : 0;
  const uptime = fmt.dur(Date.now() - pool.createdAt);
  const statusTag = pool.status === "running"
    ? <span className="tag tag-good">Running</span>
    : pool.status === "inactive"
      ? <span className="tag tag-warn">Inactive</span>
      : <span className="tag">Unknown</span>;
  const boostTag = pow.boost ? <span className="tag tag-good">Boost 1.1x</span> : <span className="tag">No boost</span>;

  return (
    <div className="pool-card">
      <div className="pool-top">
        <div>
          <div className="pool-id">Pool #<span className="mono">{pool.id}</span></div>
          <div style={{ marginTop: '8px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {statusTag}
            {boostTag}
          </div>
        </div>
        <div className="actions">
          <button className="btn btn-sm btn-primary" onClick={onManage}>Manage</button>
          <button className="btn btn-sm btn-ghost" onClick={onViewNfts}>Staked NFTs</button>
        </div>
      </div>
      <div className="pool-stats">
        <div className="mini">
          <div className="label">Power</div>
          <div className="value mono">{fmt.num(pow.boosted)} CU/s</div>
        </div>
        <div className="mini">
          <div className="label">Network share</div>
          <div className="value mono">{fmt.pct(share)}</div>
        </div>
        <div className="mini">
          <div className="label">Staked NFTs</div>
          <div className="value mono">{fmt.num(pow.staked)}</div>
        </div>
        <div className="mini">
          <div className="label">Uptime</div>
          <div className="value mono">{uptime}</div>
        </div>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { mockDB, refreshKey, connect } = useApp();

  useEffect(() => {
    // Force re-render on refreshKey change
  }, [refreshKey]);

  const total = mockDB.network.totalPower;
  const myNfts = mockDB.nfts.length;
  const myPools = mockDB.pools.filter((p) => p.status !== "deleted").length;
  const myTotalPower = mockDB.pools
    .filter((p) => p.status !== "deleted")
    .map(poolPower)
    .reduce((a, b) => a + b.boosted, 0);
  const myShare = total > 0 ? myTotalPower / total : 0;

  const pools = mockDB.pools.filter((p) => p.status !== "deleted");

  return (
    <Layout currentPage="dashboard">
      <section className="hero">
        <div className="hero-title">
          <div>
            <h1>Capacity Network Overview</h1>
            <p className="sub">
              Smart-contract driven mining pools. Stake CapacityUnit NFTs to contribute power,
              track your share, and manage on-chain mappings.
            </p>
          </div>
          <Link className="btn btn-ghost btn-sm" to="/pools">Manage Pools</Link>
        </div>

        <div className="grid">
          <div className="kpi">
            <div className="kpi-label">Total Network Power</div>
            <div className="kpi-value mono">{fmt.num(total)} <small>CU/s</small></div>
          </div>
          <div className="kpi">
            <div className="kpi-label">My CapacityUnits</div>
            <div className="kpi-value mono">{fmt.num(myNfts)}</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">My Pools</div>
            <div className="kpi-value mono">{fmt.num(myPools)}</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">My Total Power</div>
            <div className="kpi-value mono">{fmt.num(myTotalPower)} <small>CU/s</small></div>
          </div>
          <div className="kpi">
            <div className="kpi-label">My Network Share</div>
            <div className="kpi-value mono">{fmt.pct(myShare)}</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">RWA Mapping Signal</div>
            <div className="kpi-value mono">Stable</div>
            <div className="muted" style={{ marginTop: '8px', fontSize: '12px', lineHeight: '1.35' }}>
              Prototype indicator for "asset-to-capacity" mapping quality.
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section-title">
          <h2>My Pools</h2>
          <span className="hint">On-chain runtime, power, and staking mapping</span>
        </div>
        <div className="list" id="myPoolsList">
          {!mockDB.wallet.connected ? (
            <EmptyState desc="Connect wallet to view your pools." cta="Connect Wallet" onClick={connect} />
          ) : pools.length === 0 ? (
            <EmptyState desc="No pools yet. Apply with CapacityUnit NFTs." cta="Apply for a Pool" onClick={() => window.location.href = '/pool/pools'} />
          ) : (
            pools.map(p => (
              <PoolCard
                key={p.id}
                pool={p}
                total={total}
                onManage={() => window.location.href = `/pool/vault#pool=${p.id}`}
                onViewNfts={() => window.location.href = `/pool/vault#pool=${p.id}`}
              />
            ))
          )}
        </div>
      </section>

      <section className="section">
        <div className="section-title">
          <h2>Quick Actions</h2>
          <span className="hint">Vault & activity</span>
        </div>
        <div className="grid quick-actions-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <Link className="card" to="/vault">
            <div className="card-inner">
              <div className="row">
                <div>
                  <div style={{ fontWeight: '600' }}>NFT Vault</div>
                  <div className="muted" style={{ marginTop: '6px', fontSize: '12px', lineHeight: '1.35' }}>
                    View CapacityUnit IDs and staking mapping per pool.
                  </div>
                </div>
                <span className="tag">Warehouse</span>
              </div>
            </div>
          </Link>
          <Link className="card" to="/activity">
            <div className="card-inner">
              <div className="row">
                <div>
                  <div style={{ fontWeight: '600' }}>Activity</div>
                  <div className="muted" style={{ marginTop: '6px', fontSize: '12px', lineHeight: '1.35' }}>
                    On-chain transaction states: sign → submit → confirm.
                  </div>
                </div>
                <span className="tag">Tx log</span>
              </div>
            </div>
          </Link>
        </div>
      </section>
    </Layout>
  );
}

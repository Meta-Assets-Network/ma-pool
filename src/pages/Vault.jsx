import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import Layout from '../components/Layout';
import { useApp } from '../utils/AppContext';
import { fmt, availableNFTs, stakedNFTs } from '../utils/db';

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

export default function Vault() {
  const { mockDB, refreshKey, connect } = useApp();
  const [view, setView] = useState('available');
  const [search, setSearch] = useState('');
  const [focusPool, setFocusPool] = useState(null);

  useEffect(() => {
    const hash = window.location.hash || "";
    const poolMatch = hash.match(/pool=(\d+)/);
    if (poolMatch) {
      setFocusPool(Number(poolMatch[1]));
    }
  }, []);

  const avail = availableNFTs();
  const staked = stakedNFTs();
  let items = view === 'staked' ? staked : avail;
  if (focusPool) items = items.filter((n) => (view === 'staked' ? n.stakedTo === focusPool : true));
  if (search) items = items.filter((n) => String(n.id).includes(search));

  const limit = 120;
  const sliced = items.slice(0, limit);
  const more = items.length - sliced.length;

  return (
    <Layout currentPage="vault">
      <section className="hero">
        <div className="hero-title">
          <div>
            <h1>NFT Vault</h1>
            <p className="sub" id="vaultHint">
              {focusPool ? `Showing staked mapping for Pool #${focusPool}` : "Manage CapacityUnit NFTs and their staking mapping."}
            </p>
          </div>
          <Link className="btn btn-ghost btn-sm" to="/pools">Pools</Link>
        </div>

        <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <div className="kpi">
            <div className="kpi-label">Available</div>
            <div className="kpi-value mono" id="vaultAvail">{fmt.num(avail.length)}</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">Staked</div>
            <div className="kpi-value mono" id="vaultStaked">{fmt.num(staked.length)}</div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section-title">
          <h2>Browse</h2>
          <span className="hint">Search by NFT ID</span>
        </div>
        <div className="card">
          <div className="card-inner">
            <div className="row" style={{ gap: '10px' }}>
              <select
                id="vaultView"
                value={view}
                onChange={(e) => setView(e.target.value)}
                style={{ width: '42%' }}
              >
                <option value="available" selected>Available</option>
                <option value="staked">Staked</option>
              </select>
              <input
                id="vaultSearch"
                placeholder="Search NFT ID (e.g. 120123)"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                style={{ width: '58%' }}
              />
            </div>
            <div className="muted" style={{ marginTop: '10px', fontSize: '12px', lineHeight: '1.35' }}>
              Tip: open a pool mapping view via <span className="mono">vault.html#pool=&lt;id&gt;</span>.
            </div>
          </div>
        </div>
      </section>

      <section className="section" id="vaultList">
        {!mockDB.wallet.connected ? (
          <EmptyState desc="Connect wallet to load NFT vault." cta="Connect Wallet" onClick={connect} />
        ) : (
          <>
            <div className="rule">
              <div className="row">
                <div>
                  <strong>CapacityUnit</strong>
                  <div className="muted" style={{ marginTop: '6px', fontSize: '12px' }}>Each NFT has a unique ID. Mapping: NFT → Pool staking → Power.</div>
                </div>
                <span className="tag">{view === "staked" ? "Staked" : "Available"}</span>
              </div>
            </div>
            <div className="card" style={{ marginTop: '12px' }}>
              <div className="card-inner">
                <div className="list" id="nftRows">
                  {sliced.map(n => (
                    <div key={n.id} className="kpi" style={{ padding: '12px' }}>
                      <div className="row">
                        <div>
                          <div className="kpi-label">CapacityUnit NFT</div>
                          <div className="kpi-value mono" style={{ fontSize: '16px', marginTop: '6px' }}>#{n.id}</div>
                          <div className="muted" style={{ marginTop: '6px', fontSize: '12px' }}>
                            {n.stakedTo ? `Staked to <strong>Pool #<span className="mono">${n.stakedTo}</span></strong>` : "Available in vault"}
                          </div>
                        </div>
                        {n.stakedTo ? <span className="tag tag-good">Staked</span> : <span className="tag">Available</span>}
                      </div>
                    </div>
                  ))}
                </div>
                {more > 0 && (
                  <div className="muted" style={{ marginTop: '10px', fontSize: '12px' }}>
                    Showing first {limit}. {more} more… refine with search.
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </section>
    </Layout>
  );
}

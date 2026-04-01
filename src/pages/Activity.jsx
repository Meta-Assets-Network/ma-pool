import { Link } from 'react-router-dom';
import Layout from '../components/Layout';
import { useApp } from '../utils/AppContext';

function monoDigits(text) {
  const parts = text.split(/(\d[\d,./:x×]*\d*|\d)/g);
  return parts.map((part, i) =>
    /^\d/.test(part) ? <span key={i} className="mono">{part}</span> : part
  );
}

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

export default function Activity() {
  const { mockDB, addToast } = useApp();

  return (
    <Layout currentPage="activity">
      <section className="hero">
        <div className="hero-title">
          <div>
            <h1>Activity</h1>
            <p className="sub">Chain interaction states: signature → submission → confirmations → result.</p>
          </div>
          <Link className="btn btn-ghost btn-sm" to="/pools">Pools</Link>
        </div>

        <div className="activity-kpi-grid">
          <div className="kpi">
            <div className="kpi-label">Status model</div>
            <div className="kpi-value mono" style={{ fontSize: '16px' }}>DApp-grade</div>
            <div className="muted" style={{ marginTop: '8px', fontSize: '12px', lineHeight: '1.35' }}>
              Each action shows the on-chain lifecycle with feedback.
            </div>
          </div>
          <div className="kpi">
            <div className="kpi-label">Explorer</div>
            <div className="kpi-value mono" style={{ fontSize: '16px' }}>Pluggable</div>
            <div className="muted" style={{ marginTop: '8px', fontSize: '12px', lineHeight: '1.35' }}>
              Wire your chain explorer base URL later.
            </div>
          </div>
          <div className="kpi">
            <div className="kpi-label">Mapping</div>
            <div className="kpi-value mono" style={{ fontSize: '16px' }}>NFT ↔ Pool</div>
            <div className="muted" style={{ marginTop: '8px', fontSize: '12px', lineHeight: '1.35' }}>
              Activity aligns with vault & pool state.
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section-title">
          <h2>Recent transactions</h2>
          <span className="hint">Latest 20</span>
        </div>
        <div className="list" id="activityList">
          {!mockDB.wallet.connected ? (
            <EmptyState desc="Connect wallet to view activity history." cta="Connect Wallet" onClick={() => window.location.reload()} />
          ) : mockDB.activity.length === 0 ? (
            <EmptyState desc="No activity yet." cta="Go to Pools" onClick={() => window.location.href = '/pool/pools'} />
          ) : (
            mockDB.activity.slice(0, 20).map(a => {
              const kind = a.status === "confirmed" ? "tag-good" : a.status === "failed" ? "tag-bad" : "tag-warn";
              return (
                <div key={a.id} className="pool-card">
                  <div className="pool-top">
                    <div>
                      <div className="pool-id">{monoDigits(a.type)}</div>
                      <div className="muted" style={{ marginTop: '6px', fontSize: '12px' }}>{monoDigits(a.detail)}</div>
                      <div className="muted2 mono" style={{ marginTop: '8px', fontSize: '12px' }}>{new Date(a.time).toLocaleString()}</div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'flex-end' }}>
                      <span className={`tag ${kind}`}>{a.status}</span>
                      <button className="btn btn-sm btn-ghost" onClick={() => addToast("Explorer link", `Tx: ${a.tx} (wire explorer URL later)`, "warn")}>View Tx</button>
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

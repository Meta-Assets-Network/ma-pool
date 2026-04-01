import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../utils/AppContext';

export function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export default function Layout({ children, currentPage }) {
  const { wallet, toasts, removeToast, connect, disconnect } = useApp();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const handleCopyAddress = () => {
    if (wallet.address) {
      navigator.clipboard?.writeText(wallet.address);
      document.getElementById("walletMenu")?.classList.remove("show");
    }
  };

  const handleViewExplorer = () => {
    document.getElementById("walletMenu")?.classList.remove("show");
  };

  const handleDisconnect = () => {
    disconnect();
  };

  const handleNavClick = (href) => {
    setSidebarOpen(false);
    navigate(href);
  };

  const navItems = [
    {
      key: 'dashboard', label: 'Dashboard', href: '/',
      icon: <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="7" height="7" rx="1.5"/><rect x="11" y="2" width="7" height="7" rx="1.5"/><rect x="2" y="11" width="7" height="7" rx="1.5"/><rect x="11" y="11" width="7" height="7" rx="1.5"/></svg>,
    },
    {
      key: 'pools', label: 'Pools', href: '/pools',
      icon: <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="10" cy="10" r="3"/><path d="M10 2a8 8 0 0 1 0 16"/><path d="M10 2a8 8 0 0 0 0 16"/><path d="M1.5 13.5a14 14 0 0 1 17 0"/><path d="M1.5 6.5a14 14 0 0 0 17 0"/></svg>,
    },
    {
      key: 'vault', label: 'NFT Vault', href: '/vault',
      icon: <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M10 2l6 3.5v6L10 15 4 11.5v-6L10 2z"/><path d="M10 15v3"/><path d="M4 11.5L2 13l8 4.5L18 13l-2-1.5"/></svg>,
    },
    {
      key: 'activity', label: 'Activity', href: '/activity',
      icon: <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="10" cy="10" r="8"/><polyline points="10 5 10 10 13.5 12"/></svg>,
    },
  ];

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <button
            className={`hamburger ${sidebarOpen ? 'active' : ''}`}
            onClick={() => setSidebarOpen(!sidebarOpen)}
            aria-label="Toggle menu"
          >
            <span></span>
            <span></span>
            <span></span>
          </button>

          <a className="brand" href="/" aria-label="MetaAssets Chain">
            <div className="brand-badge"></div>
            <div className="brand-title">
              <strong>MetaAssets Chain</strong>
              <span id="walletState">{wallet.connected ? "Connected" : "Not connected"}</span>
            </div>
          </a>

          <div className="wallet-area">
            <button className="btn btn-primary" id="connectBtn" onClick={connect} style={{ display: wallet.connected ? 'none' : 'inline-flex' }}>
              Connect Wallet
            </button>

            <div className="wallet-pill" id="walletPill" style={{ display: wallet.connected ? 'inline-flex' : 'none' }} onClick={() => document.getElementById("walletMenu")?.classList.toggle("show")}>
              <div className="wallet-dot"></div>
              <div className="wallet-text mono">{wallet.address ? `${wallet.address.slice(0, 6)}...${wallet.address.slice(-4)}` : '0x----...----'}</div>
              <div className="wallet-caret"></div>
            </div>

            <div className="dropdown" id="walletMenu">
              <div className="dd-item" onClick={handleCopyAddress}>
                <strong>Copy address</strong>
                <span>⌘C</span>
              </div>
              <div className="dd-item" onClick={handleViewExplorer}>
                <strong>View on explorer</strong>
                <span>↗</span>
              </div>
              <div className="dd-sep"></div>
              <div className="dd-item" onClick={handleDisconnect}>
                <strong>Disconnect</strong>
                <span>⏻</span>
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="container">
        {children}
      </main>

      {/* Sidebar overlay */}
      <div
        className={`sidebar-overlay ${sidebarOpen ? 'active' : ''}`}
        onClick={() => setSidebarOpen(false)}
      />

      {/* Sidebar nav */}
      <nav className={`bottom-nav ${sidebarOpen ? 'open' : ''}`} aria-label="Navigation">
        <div className="bottom-nav-inner">
          {navItems.map(item => (
            <div
              key={item.key}
              className={`nav-item ${currentPage === item.key ? 'active' : ''}`}
              onClick={() => handleNavClick(item.href)}
            >
              <div className="nav-ico">{item.icon}</div>
              <div className="nav-label">{item.label}</div>
            </div>
          ))}
        </div>
      </nav>

      {/* Toasts */}
      <div className="toasts" id="toasts">
        {toasts.map(toast => (
          <div key={toast.id} className={`toast ${toast.kind}`}>
            <div className="left">
              <div className="dot"></div>
              <div>
                <strong>{escapeHtml(toast.title)}</strong>
                {toast.desc && <p>{escapeHtml(toast.desc)}</p>}
              </div>
            </div>
            <button className="x" aria-label="Close" onClick={() => removeToast(toast.id)}>✕</button>
          </div>
        ))}
      </div>

      {/* Confirm sheet */}
      <div className="overlay" id="overlay" aria-hidden="true">
        <div className="sheet" id="sheet" style={{ display: 'none' }}>
          <div className="handle"></div>
          <div className="sheet-head">
            <div className="sheet-title" id="sheetTitle">Confirm</div>
            <button className="btn btn-sm btn-ghost" id="sheetClose">Close</button>
          </div>
          <div className="sheet-body">
            <div className="muted" id="sheetBodyHint" style={{ fontSize: '12px', lineHeight: '1.35' }}></div>
            <div id="sheetKv" style={{ marginTop: '10px' }}></div>
            <div style={{ display: 'flex', gap: '10px', marginTop: '14px' }}>
              <button className="btn btn-ghost btn-block" id="sheetSecondary">Cancel</button>
              <button className="btn btn-primary btn-block" id="sheetPrimary">Confirm & Sign</button>
            </div>
          </div>
        </div>
      </div>

      {/* Tx sheet */}
      <div className="overlay" id="overlayTx" aria-hidden="true">
        <div className="sheet" id="sheetTx" style={{ display: 'none' }}>
          <div className="handle"></div>
          <div className="sheet-head">
            <div className="sheet-title">Transaction</div>
            <button className="btn btn-sm btn-ghost" id="txLink">Explorer</button>
          </div>
          <div className="sheet-body">
            <div className="kv">
              <div className="k">Status</div>
              <div className="v" id="txStage">—</div>
            </div>
            <div style={{ marginTop: '10px' }}>
              <div style={{ fontWeight: '600' }} id="txTitle">Awaiting signature…</div>
              <div className="muted" style={{ marginTop: '6px', fontSize: '12px', lineHeight: '1.35' }} id="txDesc"></div>
            </div>
            <div className="kv" style={{ marginTop: '10px' }}>
              <div className="k">Tx</div>
              <div className="v mono" id="txHash">--</div>
            </div>
            <div style={{ marginTop: '14px' }}>
              <button className="btn btn-primary btn-block" id="txPrimary">Hide</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

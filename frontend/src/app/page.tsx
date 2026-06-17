import { ConnectBar } from "@/components/ConnectBar";
import { NetworkGuard } from "@/components/NetworkGuard";
import { StatsCards } from "@/components/StatsCards";
import { MyMiner } from "@/components/MyMiner";
import { StakePanel } from "@/components/StakePanel";
import { MinersTable } from "@/components/MinersTable";
import { EventsFeed } from "@/components/EventsFeed";

export default function Home() {
  return (
    <main className="container">
      <header className="topbar">
        <div className="brand">
          <img className="brand-mark" src="/gem.svg" alt="MA Pool" width={38} height={38} />
          <div>
            <h1>MA POOL</h1>
            <small>Meta Assets Chain · POCC</small>
          </div>
        </div>
        <ConnectBar />
      </header>

      <NetworkGuard />

      <div className="grid" style={{ gap: 16 }}>
        <StatsCards />
        <div className="grid grid-main">
          <div className="grid" style={{ gap: 16 }}>
            <MyMiner />
            <StakePanel />
          </div>
          <EventsFeed />
        </div>
        <MinersTable />
      </div>
    </main>
  );
}

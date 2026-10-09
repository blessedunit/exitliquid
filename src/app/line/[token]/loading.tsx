// Instant shell of a line page: shows the moment a row is clicked (the board prefetches it on hover),
// while the server reads the token from vibe/vibe. Same shapes as LiveHero, so nothing jumps when it lands.
import hero from "@/components/LiveHero.module.css";
import head from "@/components/TokenHead.module.css";
import sum from "@/components/analytics/summary.module.css";

const KPIS = ["MCAP", "1H", "Vol 24H", "B / S 1H", "Holders", "To grad"];

export default function LineLoading() {
  return (
    <section className={`wrap ${hero.hero}`} aria-busy="true" aria-label="Loading the line">
      <nav className={head.crumb} aria-hidden>
        <span>Tokens</span>
        <span>/</span>
        <span className={`${head.skel} ${head.skelSm}`} style={{ width: 60 }} />
      </nav>
      <header className={head.head}>
        <div className={head.id}>
          <span className={head.avatarSlot}>
            <span className={head.skel} style={{ width: 48, height: 48 }} />
          </span>
          <div className={head.names}>
            <div className={head.titleRow}>
              <span className={head.sym}>
                <span className={head.skel} />
              </span>
            </div>
            <div className={head.sub}>
              <span className={`${head.skel} ${head.skelSm}`} />
            </div>
          </div>
        </div>
      </header>
      {/* the summary's shape: grade square + two lines, then the six KPI labels */}
      <div className={sum.bar} aria-hidden>
        <div className={sum.top}>
          <span className={`${sum.grade} ${sum.gNone} ${sum.pulse}`} />
          <div className={sum.read}>
            <span className={`${head.skel} ${head.skelSm}`} style={{ width: "70%", height: 16 }} />
            <span className={`${head.skel} ${head.skelSm}`} style={{ width: "40%", height: 12 }} />
          </div>
        </div>
        <dl className={sum.kpis}>
          {KPIS.map((k) => (
            <div key={k} className={sum.kpi}>
              <dt>{k}</dt>
              <dd><span className={`${head.skel} ${head.skelSm}`} style={{ width: 72, height: 22 }} /></dd>
            </div>
          ))}
        </dl>
      </div>
      <div className={hero.tabs} style={{ height: 48 }} aria-hidden />
      <div className={hero.corr}>
        <div className={hero.stage} />
        <div className={hero.corrFoot}>
          <span className={hero.range} role="status">Reading the line…</span>
        </div>
      </div>
      {/* the tape and the blocks come below: keep the footer under the fold until they do (CLS) */}
      <div style={{ minHeight: "100vh" }} aria-hidden />
    </section>
  );
}

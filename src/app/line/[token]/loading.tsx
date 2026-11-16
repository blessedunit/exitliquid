// Instant shell of a line page: shows the moment a row is clicked (the board prefetches it on hover),
// while the server reads the token from vibe/vibe. Same shapes as the report's verdict, so nothing jumps when it lands.
import hero from "@/components/LiveHero.module.css";
import head from "@/components/TokenHead.module.css";
import rp from "@/components/token/Report.module.css";
import Loader, { shimmer } from "@/components/ui/Loader";

const TILES = ["Snipers", "Bundled", "Top 10", "Dev holds", "Real vol", "In profit"];

export default function LineLoading() {
  return (
    <section className={`wrap ${hero.hero}`} aria-busy="true" aria-label="Loading the line">
      <nav className={head.crumb} aria-hidden>
        <span>Tokens</span>
        <span>/</span>
        <span className={`${head.skel} ${head.skelSm} ${shimmer}`} style={{ width: 60 }} />
      </nav>
      <header className={head.head}>
        <div className={head.id}>
          <span className={head.avatarSlot}>
            <span className={`${head.skel} ${shimmer}`} style={{ width: 48, height: 48 }} />
          </span>
          <div className={head.names}>
            <div className={head.titleRow}>
              <span className={head.sym}>
                <span className={`${head.skel} ${shimmer}`} />
              </span>
            </div>
            <div className={head.sub}>
              <span className={`${head.skel} ${head.skelSm} ${shimmer}`} />
            </div>
          </div>
        </div>
      </header>
      {/* the verdict's shape: grade square + the word, the walking loader, then the six tile labels */}
      <div className={rp.verdict} aria-hidden>
        <div className={rp.top}>
          <div className={rp.head}>
            <span className={`${rp.grade} ${rp.gNone}`}><Loader size="mini" /></span>
            <div className={rp.read}>
              <p className={`${rp.word} ${rp.vUnknown}`}>Reading the chain…</p>
            </div>
          </div>
          <Loader className={rp.verdictWait} />
        </div>
        <dl className={rp.tiles}>
          {TILES.map((k) => (
            <div key={k} className={rp.tile}>
              <dt className={rp.lab}>{k}</dt>
              <dd className={rp.tv}><span className={`${head.skel} ${head.skelSm} ${shimmer}`} style={{ width: 72, height: 28 }} /></dd>
            </div>
          ))}
        </dl>
      </div>
      {/* the sections come below: keep the footer under the fold until they do (CLS) */}
      <div style={{ minHeight: "100vh" }} aria-hidden />
    </section>
  );
}

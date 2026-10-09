import type { Metadata } from "next";
import EvacMap from "@/components/EvacMap";
import PageHead from "@/components/PageHead";
import { ROOMS, STATUS_LABEL } from "@/lib/roadmap";
import k from "../_kit/kit.module.css";

export const metadata: Metadata = {
  alternates: { canonical: "/map" },
  title: "Evacuation Map",
  description: "The $EXIT roadmap, drawn as a fire-evacuation plan: what is built, what is being built, and ideas.",
};

export default function MapPage() {
  return (
    <section>
      <div className="wrap">
        <PageHead title="Evacuation Map">
          The plan on the wall nobody reads. Built, building and ideas. No dates.
        </PageHead>
        <EvacMap />
        <div className="mapCards" style={{ marginTop: 32, display: "grid" }}>
          {ROOMS.map((r) => (
            <div key={r.id} style={{ display: "grid", gap: 8, padding: "20px 0", borderTop: "1px solid var(--line)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
                <h2 className={k.h3}>
                  <span className={`${k.num} ${k.dim}`} style={{ marginRight: 10 }}>{r.code}</span>
                  {r.name}
                </h2>
                <span className={`${k.st} ${r.status === "now" ? k.stMid : r.status === "done" ? k.stGood : ""}`}>{STATUS_LABEL[r.status]}</span>
              </div>
              <ul style={{ margin: 0, paddingLeft: 18, color: "var(--t2)", font: "400 14px/22px var(--f-ui)" }}>
                {r.items.map((i) => (
                  <li key={i}>{i}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// Page intro (spec §1.2/§1.3): the Grotesk H1 (32/40) and one lead (16/24 --t2) that answers the page's
// question. `aside` sits on the right of the H1 row as a meta line (a snapshot time, a live dot).
// `kicker` is accepted for old callers but no longer rendered (the eyebrows are gone).
export default function PageHead({
  title,
  children,
  aside,
}: {
  title: React.ReactNode;
  children?: React.ReactNode;
  kicker?: React.ReactNode;
  aside?: React.ReactNode;
}) {
  return (
    <div className="pageHead">
      {aside ? (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", justifyContent: "space-between", gap: "8px 24px", width: "100%" }}>
          <h1 className="sign">{title}</h1>
          <span className="meta">{aside}</span>
        </div>
      ) : (
        <h1 className="sign">{title}</h1>
      )}
      {children && <p className="lead">{children}</p>}
    </div>
  );
}

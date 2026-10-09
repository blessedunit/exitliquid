"use client";
// The one "paste an address" form of /w, /dev and /lines: same 52 px field, one primary button,
// an optional quiet secondary action under it (e.g. "or Connect a wallet"), the error line.
// Controlled: the page owns the value and what a submit does.
import s from "./w.module.css";

export default function LookupField({
  id,
  label,
  placeholder,
  cta,
  value,
  onChange,
  onSubmit,
  error = null,
  busy = false,
  busyCta,
  after,
}: {
  id: string;
  label: string;
  placeholder: string;
  cta: string;
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  error?: string | null;
  busy?: boolean;
  busyCta?: string;
  /** quiet line under the field: an alternative action, or examples */
  after?: React.ReactNode;
}) {
  return (
    <div className={s.lookupWrap}>
      <form
        className={s.lookup}
        role="search"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(value);
        }}
      >
        <label htmlFor={id} className="srOnly">{label}</label>
        <input
          id={id}
          className="input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          enterKeyHint="go"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-err` : undefined}
        />
        <button type="submit" className="btn start" disabled={busy}>{busy && busyCta ? busyCta : cta}</button>
      </form>
      {error && <p id={`${id}-err`} className={s.lookupErr} role="alert">{error}</p>}
      {after}
    </div>
  );
}

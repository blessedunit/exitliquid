"use client";
// The "paste an address" form of /w: one field, one primary button, the error line.
// Controlled: the caller owns the value and what a submit does.
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
}: {
  id: string;
  label: string;
  placeholder: string;
  cta: string;
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  error?: string | null;
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
        <button type="submit" className="btn start">{cta}</button>
      </form>
      {error && <p id={`${id}-err`} className={s.lookupErr} role="alert">{error}</p>}
    </div>
  );
}

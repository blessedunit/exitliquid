"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import SearchSuggest, { type SearchSuggestProps } from "./SearchSuggest";
import type { NavItem } from "@/lib/nav";

const under = (path: string, href: string) => (href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`));

// Menu entries; the current page gets a tiny static pixel ▶ (global .menuItem).
// No viewport prefetch (every page would fetch the whole menu); a pointer or focus resting on an item
// prefetches that one page, so the click lands on a page that is already on its way.
export default function NavLinks({ items, className }: { items: NavItem[]; className?: string }) {
  const path = usePathname();
  const router = useRouter();
  const warm = (href: string) => {
    if (href.includes("#") || under(path, href)) return;
    router.prefetch(href);
  };
  return (
    <>
      {items.map((n) => {
        const here = !n.href.includes("#") && [n.href, ...(n.also ?? [])].some((h) => under(path, h));
        return (
          <Link
            key={n.href}
            href={n.href}
            prefetch={false}
            className={`menuItem ${className ?? ""}`}
            aria-current={here ? "page" : undefined}
            onPointerEnter={() => warm(n.href)}
            onFocus={() => warm(n.href)}
          >
            {n.label}
          </Link>
        );
      })}
    </>
  );
}

// Global search (typeahead, keyboard, v6-aware) lives in SearchSuggest; this name stays for Header.tsx.
// `hotkey` binds "/" to focus this box (only one instance should have it).
export function HeaderSearch(props: SearchSuggestProps) {
  return <SearchSuggest {...props} />;
}

/**
 * Sticky jump-to-section sidebar for long text pages (Privacy Policy, Terms
 * of Service). Plain anchor links — no scroll-spy/active-highlight JS, so it
 * stays a server component and adds no client bundle for a list that only
 * needs to jump.
 */
export function TableOfContents({ items }: { items: { id: string; label: string }[] }) {
  return (
    <nav aria-label="Table of contents" className="lg:sticky lg:top-24">
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-fg-muted">On this page</p>
      <ol className="mt-4 space-y-2.5 border-l border-white/[0.08] pl-4">
        {items.map((item) => (
          <li key={item.id}>
            <a href={`#${item.id}`} className="text-sm text-zinc-400 transition-colors hover:text-white">
              {item.label}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

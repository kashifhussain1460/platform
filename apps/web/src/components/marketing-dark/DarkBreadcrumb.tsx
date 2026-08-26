import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { JsonLd, breadcrumbSchema } from '@/lib/jsonld';

export interface Crumb {
  name: string;
  path: string;
}

/** Breadcrumb nav + matching BreadcrumbList JSON-LD, shared by detail pages. */
export function DarkBreadcrumb({ items }: { items: Crumb[] }) {
  return (
    <>
      <JsonLd data={breadcrumbSchema(items)} />
      <nav aria-label="Breadcrumb" className="mx-auto max-w-[1440px] px-8 pt-8">
        <ol className="flex flex-wrap items-center gap-1.5 text-sm text-zinc-400">
          {items.map((item, i) => {
            const isLast = i === items.length - 1;
            return (
              <li key={item.path} className="flex items-center gap-1.5">
                {i > 0 && <ChevronRight className="h-3.5 w-3.5 text-fg-muted" aria-hidden />}
                {isLast ? (
                  <span aria-current="page" className="text-zinc-200">
                    {item.name}
                  </span>
                ) : (
                  <Link href={item.path} className="transition-colors hover:text-white">
                    {item.name}
                  </Link>
                )}
              </li>
            );
          })}
        </ol>
      </nav>
    </>
  );
}

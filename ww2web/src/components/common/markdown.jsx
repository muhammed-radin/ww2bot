import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Link2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSlug from 'rehype-slug';
import { cn } from '@/lib/utils.js';

/**
 * Relative links inside `docs/` point at sibling files (`./storage.md`) and
 * section anchors (`#data-directory-layout`). Both are rewritten to HashRouter
 * routes so the documentation stays navigable inside the dashboard instead of
 * 404-ing against the API host.
 *
 * Only links that resolve *inside* the bundled `docs/` directory are routed.
 * Links to other repository files (for example `../.env.example` or
 * `../tests/live/README.md`) are rendered as plain text, because those files
 * are not part of the published documentation and pretending otherwise would
 * produce a broken navigation.
 */
const DOC_LINK = /^(?:\.\/)?(?:docs\/)?([A-Za-z0-9._-]+)\.md(?:#(.*))?$/;
const PROTOCOL = /^[a-z][a-z0-9+.-]*:/i;

function resolveHref(href, currentId) {
  if (!href) return { kind: 'none' };
  if (href.startsWith('#')) {
    return { kind: 'route', to: { pathname: `/docs/${currentId}`, hash: href.slice(1) } };
  }
  if (PROTOCOL.test(href)) return { kind: 'external', href };

  const match = href.match(DOC_LINK);
  if (match) {
    return {
      kind: 'route',
      to: { pathname: `/docs/${match[1].toLowerCase()}`, hash: match[2] ?? '' },
    };
  }
  if (href.startsWith('/')) return { kind: 'route', to: href };
  return { kind: 'unbundled', href };
}

const HEADINGS = {
  h1: 'mb-4 mt-0 text-2xl font-semibold tracking-tight',
  h2: 'mb-3 mt-8 border-b border-border pb-2 text-xl font-semibold tracking-tight',
  h3: 'mb-2 mt-6 text-lg font-semibold tracking-tight',
  h4: 'mb-2 mt-5 text-base font-semibold',
  h5: 'mb-2 mt-4 text-sm font-semibold uppercase tracking-wide text-muted-foreground',
  h6: 'mb-2 mt-4 text-sm font-semibold text-muted-foreground',
};

function createComponents(currentId) {
  const heading = (tag, className) =>
    function Heading({ id, children }) {
      const Tag = tag;
      return (
        <Tag id={id} className={cn('group scroll-mt-24', className)}>
          {children}
          {id ? (
            <Link
              to={{ pathname: `/docs/${currentId}`, hash: id }}
              aria-label="Link to this section"
              className="ml-2 inline-flex align-middle text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
            >
              <Link2 className="size-3.5" aria-hidden="true" />
            </Link>
          ) : null}
        </Tag>
      );
    };

  return {
    h1: heading('h1', HEADINGS.h1),
    h2: heading('h2', HEADINGS.h2),
    h3: heading('h3', HEADINGS.h3),
    h4: heading('h4', HEADINGS.h4),
    h5: heading('h5', HEADINGS.h5),
    h6: heading('h6', HEADINGS.h6),

    p: ({ children }) => <p className="my-3 text-sm leading-relaxed">{children}</p>,
    ul: ({ children }) => <ul className="my-3 list-disc space-y-1.5 pl-6 text-sm leading-relaxed">{children}</ul>,
    ol: ({ children }) => <ol className="my-3 list-decimal space-y-1.5 pl-6 text-sm leading-relaxed">{children}</ol>,
    li: ({ children }) => <li className="[&>p]:my-0">{children}</li>,

    a: ({ href, title, children }) => {
      const target = resolveHref(href, currentId);
      if (target.kind === 'route') {
        return (
          <Link to={target.to} title={title} className="font-medium text-primary underline underline-offset-2 hover:no-underline">
            {children}
          </Link>
        );
      }
      if (target.kind === 'none') return <span>{children}</span>;
      if (target.kind === 'unbundled') {
        return (
          <span
            title={`Not part of the bundled documentation: ${target.href}`}
            className="font-medium text-muted-foreground"
          >
            {children}
          </span>
        );
      }
      return (
        <a
          href={target.href}
          title={title}
          target="_blank"
          rel="noreferrer noopener"
          className="font-medium text-primary underline underline-offset-2 hover:no-underline"
        >
          {children}
        </a>
      );
    },

    code: ({ className, children }) =>
      /language-/.test(className ?? '') ? (
        <code className={cn('font-mono', className)}>{children}</code>
      ) : (
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em]">{children}</code>
      ),
    pre: ({ children }) => (
      <pre className="my-4 overflow-x-auto rounded-lg border border-border bg-muted/60 p-4 text-[13px] leading-relaxed">
        {children}
      </pre>
    ),

    blockquote: ({ children }) => (
      <blockquote className="my-4 border-l-2 border-border pl-4 text-sm italic text-muted-foreground">{children}</blockquote>
    ),

    table: ({ children }) => (
      <div className="my-4 overflow-x-auto rounded-md border border-border">
        <table className="w-full border-collapse text-sm">{children}</table>
      </div>
    ),
    th: ({ children }) => (
      <th className="border-b border-border bg-muted/60 px-3 py-2 text-left font-semibold">{children}</th>
    ),
    td: ({ children }) => <td className="border-b border-border px-3 py-2 align-top">{children}</td>,
    hr: () => <hr className="my-6 border-border" />,
    img: ({ src, alt }) => <img src={src} alt={alt ?? ''} loading="lazy" className="my-4 max-w-full rounded-md border" />,
  };
}

/** Render one generated documentation file. */
export function Markdown({ source, docId }) {
  const components = useMemo(() => createComponents(docId), [docId]);
  return (
    <div className="markdown text-foreground">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSlug]} components={components}>
        {source}
      </ReactMarkdown>
    </div>
  );
}

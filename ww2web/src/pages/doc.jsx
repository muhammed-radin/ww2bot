import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, BookOpen, ChevronRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge.jsx';
import { Button } from '@/components/ui/button.jsx';
import { Card, CardContent } from '@/components/ui/card.jsx';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select.jsx';
import { Skeleton } from '@/components/ui/skeleton.jsx';
import { EmptyState } from '@/components/common/empty-state.jsx';
import { ErrorState } from '@/components/common/error-state.jsx';
import { Markdown } from '@/components/common/markdown.jsx';
import { PageHeader } from '@/components/common/page-header.jsx';
import { useDocumentTitle } from '@/hooks/use-document-title.js';
import { DOC_GROUPS, DOCUMENTS, findDocument, findNeighbours, loadDocumentSource } from '@/lib/docs.js';
import { cn } from '@/lib/utils.js';

function DocNav({ currentId }) {
  return (
    <nav aria-label="Documentation" className="space-y-5">
      {DOC_GROUPS.map((group) => (
        <div key={group.label} className="space-y-1">
          <p className="px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{group.label}</p>
          <ul className="space-y-0.5">
            {group.items.map((doc) => {
              const active = doc.id === currentId;
              return (
                <li key={doc.id}>
                  <Link
                    to={`/docs/${doc.id}`}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'block rounded-md px-2 py-1.5 text-sm transition-colors',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      active
                        ? 'bg-accent font-medium text-accent-foreground'
                        : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                    )}
                  >
                    {doc.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

export default function DocPage() {
  const { docId } = useParams();
  const navigate = useNavigate();
  const { hash } = useLocation();

  const doc = useMemo(() => findDocument(docId), [docId]);
  const { previous, next } = useMemo(() => findNeighbours(doc), [doc]);

  useDocumentTitle(doc ? doc.title : 'Documentation');

  const [source, setSource] = useState(null);
  const [loading, setLoading] = useState(Boolean(doc));
  const [error, setError] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!doc) {
      setSource(null);
      setLoading(false);
      return undefined;
    }

    let cancelled = false;
    setSource(null);
    setLoading(true);
    setError(null);

    loadDocumentSource(doc)
      .then((markdown) => {
        if (!cancelled) setSource(markdown);
      })
      .catch((caught) => {
        if (!cancelled) setError(caught);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [doc, reloadKey]);

  // The docs contain section links of the form `./file.md#anchor`; HashRouter
  // keeps the anchor in the route hash, so scroll to it once the Markdown has
  // actually been rendered.
  useEffect(() => {
    if (!source) return;
    if (hash && hash.length > 1) {
      const target = document.getElementById(hash.slice(1));
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
    }
    window.scrollTo({ top: 0 });
  }, [source, hash, doc?.id]);

  if (!doc) {
    return (
      <div className="space-y-6">
        <PageHeader title="Documentation" description="The requested document does not exist." />
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={BookOpen}
              title="Document not found"
              description={`No generated document matches "${docId}". It may have been renamed or removed.`}
              action={
                <Button asChild size="sm">
                  <Link to="/docs">Browse the documentation</Link>
                </Button>
              }
            />
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Documentation"
        description="Rendered from the repository's docs/ directory at build time."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link to="/docs">
              <BookOpen className="size-4" aria-hidden="true" />
              All documents
            </Link>
          </Button>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <aside className="space-y-4">
          <div className="lg:sticky lg:top-20">
            <div className="mb-3 lg:hidden">
              <label htmlFor="doc-select" className="mb-1.5 block text-xs font-medium text-muted-foreground">
                Document
              </label>
              <Select value={doc.id} onValueChange={(value) => navigate(`/docs/${value}`)}>
                <SelectTrigger id="doc-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DOC_GROUPS.map((group) => (
                    <SelectGroup key={group.label}>
                      <SelectLabel>{group.label}</SelectLabel>
                      {group.items.map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.title}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="hidden lg:block">
              <DocNav currentId={doc.id} />
            </div>
          </div>
        </aside>

        <div className="min-w-0">
          <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="muted">{doc.group}</Badge>
            <span className="font-mono">{doc.file}</span>
            <span aria-hidden="true">·</span>
            <span>{doc.lines} lines</span>
          </div>

          <article className="rounded-lg border bg-card p-5 sm:p-7">
            {loading && !source ? (
              <div className="space-y-3" aria-hidden="true">
                <Skeleton className="h-8 w-2/3" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-11/12" />
                <Skeleton className="h-4 w-4/5" />
                <Skeleton className="mt-6 h-6 w-1/2" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-10/12" />
              </div>
            ) : error ? (
              <ErrorState
                error={error}
                title="Could not load this document"
                onRetry={() => setReloadKey((value) => value + 1)}
              />
            ) : (
              <Markdown source={source ?? ''} docId={doc.id} />
            )}
          </article>

          <nav className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-stretch sm:justify-between" aria-label="Documentation pages">
            {previous ? (
              <Link
                to={`/docs/${previous.id}`}
                className="group flex flex-1 items-center gap-3 rounded-lg border bg-card px-4 py-3 transition-colors hover:border-primary/40 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ArrowLeft className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0">
                  <span className="block text-xs text-muted-foreground">Previous</span>
                  <span className="block truncate text-sm font-medium">{previous.title}</span>
                </span>
              </Link>
            ) : (
              <span className="hidden flex-1 sm:block" />
            )}

            {next ? (
              <Link
                to={`/docs/${next.id}`}
                className="group flex flex-1 items-center justify-end gap-3 rounded-lg border bg-card px-4 py-3 text-right transition-colors hover:border-primary/40 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="min-w-0">
                  <span className="block text-xs text-muted-foreground">Next</span>
                  <span className="block truncate text-sm font-medium">{next.title}</span>
                </span>
                <ArrowRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              </Link>
            ) : (
              <Link
                to="/docs"
                className="flex flex-1 items-center justify-end gap-2 rounded-lg border bg-card px-4 py-3 text-sm font-medium transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                All documents
                <ChevronRight className="size-4 text-muted-foreground" aria-hidden="true" />
              </Link>
            )}
          </nav>

          <p className="mt-4 text-xs text-muted-foreground">
            {DOCUMENTS.length} documents are generated from <span className="font-mono">docs/</span> on every build, so this page always
            matches the repository.
          </p>
        </div>
      </div>
    </div>
  );
}

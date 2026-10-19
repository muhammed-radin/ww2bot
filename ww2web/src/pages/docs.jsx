import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, BookOpen, FileText, Search } from 'lucide-react';
import { Badge } from '@/components/ui/badge.jsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card.jsx';
import { Input } from '@/components/ui/input.jsx';
import { EmptyState } from '@/components/common/empty-state.jsx';
import { PageHeader } from '@/components/common/page-header.jsx';
import { useDocumentTitle } from '@/hooks/use-document-title.js';
import { DOC_GROUPS, DOCUMENTS } from '@/lib/docs.js';

function matches(doc, query) {
  if (!query) return true;
  const haystack = `${doc.title} ${doc.description} ${doc.group} ${doc.id}`.toLowerCase();
  return haystack.includes(query);
}

export default function DocsPage() {
  useDocumentTitle('Documentation');

  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();

  const groups = useMemo(
    () =>
      DOC_GROUPS.map((group) => ({
        label: group.label,
        items: group.items.filter((doc) => matches(doc, needle)),
      })).filter((group) => group.items.length > 0),
    [needle],
  );

  const shown = groups.reduce((total, group) => total + group.items.length, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Documentation"
        description="The complete repository documentation, rendered from docs/ and shipped with the dashboard."
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search the documentation"
            aria-label="Search the documentation"
            className="pl-9"
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {needle ? `${shown} of ${DOCUMENTS.length} documents` : `${DOCUMENTS.length} documents`}
        </p>
      </div>

      {groups.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={Search}
              title="No matching documents"
              description={`Nothing in the documentation matches "${query.trim()}". Try a different word.`}
            />
          </CardContent>
        </Card>
      ) : (
        groups.map((group) => (
          <section key={group.label} className="space-y-3" aria-labelledby={`docs-group-${group.label}`}>
            <div className="flex items-center gap-2">
              <BookOpen className="size-4 text-muted-foreground" aria-hidden="true" />
              <h2 id={`docs-group-${group.label}`} className="text-sm font-semibold">
                {group.label}
              </h2>
              <Badge variant="muted">{group.items.length}</Badge>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {group.items.map((doc) => (
                <Link
                  key={doc.id}
                  to={`/docs/${doc.id}`}
                  className="group rounded-lg border bg-card transition-colors hover:border-primary/40 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <div className="flex h-full flex-col gap-2 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <p className="font-medium">{doc.title}</p>
                      <ArrowRight
                        className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
                        aria-hidden="true"
                      />
                    </div>
                    {doc.description ? (
                      <p className="line-clamp-3 text-sm text-muted-foreground">{doc.description}</p>
                    ) : null}
                    <p className="mt-auto flex items-center gap-1.5 pt-1 text-xs text-muted-foreground">
                      <FileText className="size-3.5" aria-hidden="true" />
                      <span className="font-mono">{doc.file}</span>
                      <span aria-hidden="true">·</span>
                      <span>{doc.lines} lines</span>
                    </p>
                  </div>
                </Link>
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}

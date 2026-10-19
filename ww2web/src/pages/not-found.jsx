import { Link } from 'react-router-dom';
import { Compass } from 'lucide-react';
import { Button } from '@/components/ui/button.jsx';
import { EmptyState } from '@/components/common/empty-state.jsx';
import { useDocumentTitle } from '@/hooks/use-document-title.js';

export default function NotFoundPage() {
  useDocumentTitle('Not found');
  return (
    <EmptyState
      icon={Compass}
      title="Page not found"
      description="That dashboard route does not exist. Use the navigation to reach a known page."
      action={
        <Button asChild variant="outline" size="sm">
          <Link to="/dashboard">Back to dashboard</Link>
        </Button>
      }
      className="min-h-[50vh]"
    />
  );
}

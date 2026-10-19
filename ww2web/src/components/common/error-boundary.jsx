import { Component } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button.jsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card.jsx';

/**
 * Last line of defence: a render-time crash shows a friendly panel instead of a
 * blank page. Internal details are never rendered.
 */
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    // Deliberately console-only: the browser has no legitimate place to send it.
    console.error('Dashboard render error', error, info);
  }

  handleReload = () => {
    this.setState({ hasError: false });
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="flex min-h-[60vh] items-center justify-center p-6">
        <Card className="w-full max-w-md">
          <CardHeader>
            <span className="mb-1 inline-flex size-9 items-center justify-center rounded-full bg-destructive/10 text-destructive">
              <AlertTriangle className="size-5" aria-hidden="true" />
            </span>
            <CardTitle>This view could not be displayed</CardTitle>
            <CardDescription>Reloading usually fixes a transient rendering problem.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={this.handleReload}>Reload dashboard</Button>
          </CardContent>
        </Card>
      </div>
    );
  }
}

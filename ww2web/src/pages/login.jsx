import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { KeyRound, ShieldAlert } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert.jsx';
import { Button } from '@/components/ui/button.jsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card.jsx';
import { Input } from '@/components/ui/input.jsx';
import { Label } from '@/components/ui/label.jsx';
import { Brand } from '@/components/common/brand.jsx';
import { ThemeToggle } from '@/components/common/theme-toggle.jsx';
import { useAuth } from '@/hooks/use-auth.jsx';
import { useDocumentTitle } from '@/hooks/use-document-title.js';

export default function LoginPage() {
  useDocumentTitle('Sign in');
  const { isAuthenticated, login } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(false);

  const redirectTo = location.state?.from ?? '/dashboard';

  if (isAuthenticated) return <Navigate to={redirectTo} replace />;

  async function handleSubmit(event) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      await login(apiKey.trim());
      setApiKey('');
      navigate(redirectTo, { replace: true });
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <div className="flex items-center justify-between px-4 py-3">
        <Brand />
        <ThemeToggle />
      </div>

      <div className="flex flex-1 items-center justify-center px-4 pb-16">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <span className="mb-1 inline-flex size-9 items-center justify-center rounded-md bg-primary/10 text-primary">
              <KeyRound className="size-5" aria-hidden="true" />
            </span>
            <CardTitle className="text-base">Owner sign in</CardTitle>
            <CardDescription>
              Enter an owner API key to open the administration dashboard. The key is used once and is never stored in the browser.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={handleSubmit} noValidate>
              <div className="space-y-2">
                <Label htmlFor="api-key">Owner API key</Label>
                <Input
                  id="api-key"
                  name="api-key"
                  type="password"
                  autoComplete="off"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="wak_…"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  aria-describedby="api-key-help"
                  required
                  autoFocus
                />
                <p id="api-key-help" className="text-xs text-muted-foreground">
                  Keys beginning with <span className="font-mono">wak_</span>. The RazorBills messaging key cannot sign in here.
                </p>
              </div>

              {error ? (
                <Alert variant="destructive">
                  <ShieldAlert />
                  <AlertDescription>{error.message ?? 'Sign in failed.'}</AlertDescription>
                </Alert>
              ) : null}

              <Button type="submit" className="w-full" disabled={pending || apiKey.trim() === ''}>
                {pending ? 'Signing in…' : 'Sign in'}
              </Button>
            </form>

            <p className="mt-4 border-t pt-4 text-xs text-muted-foreground">
              No owner key yet? Create one on the host with{' '}
              <span className="font-mono">npm run key:create -- --preset owner</span>.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

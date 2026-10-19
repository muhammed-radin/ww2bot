import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button.jsx';
import { cn } from '@/lib/utils.js';

async function writeToClipboard(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-9999px';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

export function CopyButton({ value, label = 'Copy', className, variant = 'ghost', size = 'sm' }) {
  const [state, setState] = useState('idle');

  async function handleCopy() {
    const ok = await writeToClipboard(String(value ?? ''));
    setState(ok ? 'copied' : 'failed');
    if (ok) setTimeout(() => setState('idle'), 2000);
  }

  const text = state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : label;

  return (
    <Button type="button" variant={variant} size={size} onClick={handleCopy} className={className}>
      {state === 'copied' ? <Check className="size-4 text-success" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
      <span>{text}</span>
    </Button>
  );
}

/** Mono-spaced value with a copy affordance, used for ids and one-time secrets. */
export function CopyableValue({ value, className, mono = true }) {
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-2', className)}>
      <code className={cn('truncate rounded bg-muted px-1.5 py-0.5 text-xs', mono && 'font-mono')} title={value}>
        {value}
      </code>
      <CopyButton value={value} label="Copy" />
    </span>
  );
}

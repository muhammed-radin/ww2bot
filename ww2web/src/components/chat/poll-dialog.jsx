import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button.jsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.jsx';
import { Input } from '@/components/ui/input.jsx';
import { Label } from '@/components/ui/label.jsx';
import { Switch } from '@/components/ui/switch.jsx';

const EMPTY = { question: '', options: ['', ''], allowMultipleAnswers: false };

/** Create a native WhatsApp poll. */
export function PollDialog({ open, onOpenChange, onSubmit, sending = false }) {
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (open) {
      setForm(EMPTY);
      setError(null);
    }
  }, [open]);

  function updateOption(index, value) {
    setForm((previous) => ({
      ...previous,
      options: previous.options.map((option, position) => (position === index ? value : option)),
    }));
  }

  async function submit(event) {
    event.preventDefault();
    const question = form.question.trim();
    const options = form.options.map((option) => option.trim()).filter(Boolean);
    if (!question) return setError('Add a question.');
    if (options.length < 2) return setError('Add at least two options.');
    if (options.length > 12) return setError('WhatsApp polls allow at most 12 options.');
    setError(null);
    try {
      await onSubmit({ question, options, allowMultipleAnswers: form.allowMultipleAnswers });
      onOpenChange(false);
    } catch (caught) {
      setError(caught?.message ?? 'The poll could not be sent.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a poll</DialogTitle>
          <DialogDescription>
            Polls are sent as native WhatsApp polls. Only the WhatsApp Web connector can create them.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="poll-question">Question</Label>
            <Input
              id="poll-question"
              value={form.question}
              onChange={(event) => setForm((previous) => ({ ...previous, question: event.target.value }))}
              maxLength={255}
              placeholder="Where shall we eat?"
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <Label>Options</Label>
            {form.options.map((option, index) => (
              <div key={index} className="flex items-center gap-2">
                <Input
                  value={option}
                  onChange={(event) => updateOption(index, event.target.value)}
                  maxLength={100}
                  placeholder={`Option ${index + 1}`}
                  aria-label={`Option ${index + 1}`}
                />
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  disabled={form.options.length <= 2}
                  onClick={() =>
                    setForm((previous) => ({
                      ...previous,
                      options: previous.options.filter((_, position) => position !== index),
                    }))
                  }
                  aria-label={`Remove option ${index + 1}`}
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={form.options.length >= 12}
              onClick={() => setForm((previous) => ({ ...previous, options: [...previous.options, ''] }))}
            >
              <Plus aria-hidden="true" />
              Add option
            </Button>
          </div>

          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <p className="text-sm font-medium">Allow multiple answers</p>
              <p className="text-xs text-muted-foreground">Recipients can select more than one option.</p>
            </div>
            <Switch
              checked={form.allowMultipleAnswers}
              onCheckedChange={(checked) => setForm((previous) => ({ ...previous, allowMultipleAnswers: checked }))}
            />
          </div>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={sending}>
              Cancel
            </Button>
            <Button type="submit" disabled={sending}>
              {sending ? 'Sending…' : 'Send poll'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

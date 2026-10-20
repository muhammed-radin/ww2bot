import { useEffect, useState } from 'react';
import { Contact } from 'lucide-react';
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

const EMPTY = { contactId: '', name: '', phone: '', organization: '' };

/**
 * Send a contact card.
 *
 * WhatsApp Web resolves a contact by its exact chat id on the linked device.
 * Cloud API has no contact-id lookup, so it needs the name and phone directly.
 * The dialog shows the correct fields for the selected connector rather than
 * pretending one shape fits both.
 */
export function ContactDialog({ open, onOpenChange, onSubmit, connector = 'web', sending = false }) {
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (open) {
      setForm(EMPTY);
      setError(null);
    }
  }, [open]);

  async function submit(event) {
    event.preventDefault();
    setError(null);
    try {
      if (connector === 'cloud_api') {
        const phone = form.phone.replace(/[^\d]/g, '');
        if (phone.length < 7) return setError('Enter an international phone number.');
        await onSubmit({
          contact: {
            name: form.name.trim() || `+${phone}`,
            phone,
            organization: form.organization.trim() || undefined,
          },
        });
      } else {
        const raw = form.contactId.trim();
        if (!raw) return setError('Enter a contact chat id or phone number.');
        const contactId = raw.includes('@') ? raw : `${raw.replace(/[^\d]/g, '')}@c.us`;
        await onSubmit({ contactId });
      }
      onOpenChange(false);
    } catch (caught) {
      setError(caught?.message ?? 'The contact could not be sent.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send a contact card</DialogTitle>
          <DialogDescription>
            {connector === 'cloud_api'
              ? 'Cloud API needs the contact name and phone number; it cannot resolve a linked-device contact id.'
              : 'WhatsApp Web looks up the exact contact on the linked device.'}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          {connector === 'cloud_api' ? (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="contact-name">Name</Label>
                <Input
                  id="contact-name"
                  value={form.name}
                  onChange={(event) => setForm((previous) => ({ ...previous, name: event.target.value }))}
                  maxLength={200}
                  placeholder="Asha Rao"
                  autoFocus
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="contact-phone">Phone number</Label>
                <Input
                  id="contact-phone"
                  value={form.phone}
                  onChange={(event) => setForm((previous) => ({ ...previous, phone: event.target.value }))}
                  inputMode="tel"
                  placeholder="+91 98123 45678"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="contact-organization">Organization (optional)</Label>
                <Input
                  id="contact-organization"
                  value={form.organization}
                  onChange={(event) => setForm((previous) => ({ ...previous, organization: event.target.value }))}
                  maxLength={200}
                  placeholder="RazorBills"
                />
              </div>
            </>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="contact-id">Contact chat id or phone number</Label>
              <Input
                id="contact-id"
                value={form.contactId}
                onChange={(event) => setForm((previous) => ({ ...previous, contactId: event.target.value }))}
                placeholder="12025550108@c.us"
                autoFocus
              />
              <p className="text-xs text-muted-foreground">
                Use the exact contact the linked device knows. A bare number is treated as a direct chat id.
              </p>
            </div>
          )}

          {error ? <p className="text-sm text-destructive">{error}</p> : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={sending}>
              Cancel
            </Button>
            <Button type="submit" disabled={sending}>
              <Contact aria-hidden="true" />
              {sending ? 'Sending…' : 'Send contact'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

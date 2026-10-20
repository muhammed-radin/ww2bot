import { useEffect, useState } from 'react';
import { LocateFixed, MapPin } from 'lucide-react';
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

const EMPTY = { latitude: '', longitude: '', name: '', address: '' };

/** Send a static location pin. Live-location sessions are not supported. */
export function LocationDialog({ open, onOpenChange, onSubmit, sending = false }) {
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState(null);
  const [locating, setLocating] = useState(false);

  useEffect(() => {
    if (open) {
      setForm(EMPTY);
      setError(null);
    }
  }, [open]);

  function useCurrentLocation() {
    if (!navigator.geolocation) {
      setError('This browser does not expose geolocation.');
      return;
    }
    setLocating(true);
    setError(null);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setForm((previous) => ({
          ...previous,
          latitude: position.coords.latitude.toFixed(6),
          longitude: position.coords.longitude.toFixed(6),
        }));
        setLocating(false);
      },
      (caught) => {
        setError(
          caught?.code === 1
            ? 'Location access was refused. Enter coordinates or allow it in the browser.'
            : 'Your location could not be read.',
        );
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }

  async function submit(event) {
    event.preventDefault();
    const latitude = Number(form.latitude);
    const longitude = Number(form.longitude);
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      return setError('Latitude must be between -90 and 90.');
    }
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      return setError('Longitude must be between -180 and 180.');
    }
    setError(null);
    try {
      await onSubmit({
        latitude,
        longitude,
        name: form.name.trim() || undefined,
        address: form.address.trim() || undefined,
      });
      onOpenChange(false);
    } catch (caught) {
      setError(caught?.message ?? 'The location could not be sent.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Share a location</DialogTitle>
          <DialogDescription>
            Sends one static pin. WhatsApp live-location sessions cannot be started by this dashboard.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <Button type="button" variant="outline" onClick={useCurrentLocation} disabled={locating}>
            <LocateFixed aria-hidden="true" />
            {locating ? 'Reading location…' : 'Use my current location'}
          </Button>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="location-latitude">Latitude</Label>
              <Input
                id="location-latitude"
                value={form.latitude}
                onChange={(event) => setForm((previous) => ({ ...previous, latitude: event.target.value }))}
                inputMode="decimal"
                placeholder="12.9716"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="location-longitude">Longitude</Label>
              <Input
                id="location-longitude"
                value={form.longitude}
                onChange={(event) => setForm((previous) => ({ ...previous, longitude: event.target.value }))}
                inputMode="decimal"
                placeholder="77.5946"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="location-name">Place name (optional)</Label>
            <Input
              id="location-name"
              value={form.name}
              onChange={(event) => setForm((previous) => ({ ...previous, name: event.target.value }))}
              maxLength={200}
              placeholder="Cubbon Park"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="location-address">Address (optional)</Label>
            <Input
              id="location-address"
              value={form.address}
              onChange={(event) => setForm((previous) => ({ ...previous, address: event.target.value }))}
              maxLength={500}
              placeholder="Bengaluru, Karnataka"
            />
          </div>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={sending}>
              Cancel
            </Button>
            <Button type="submit" disabled={sending}>
              <MapPin aria-hidden="true" />
              {sending ? 'Sending…' : 'Send location'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

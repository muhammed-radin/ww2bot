import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button.jsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.jsx';
import { downloadBlob, formatFileKind } from '@/lib/chat.js';
import { formatBytes } from '@/lib/format.js';

/** Full-size preview for an image or video already fetched as an object URL. */
export function MediaDialog({ media, open, onOpenChange }) {
  const mime = media?.mimeType ?? '';
  const isImage = mime.startsWith('image/');
  const isVideo = mime.startsWith('video/');
  const isAudio = mime.startsWith('audio/');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle className="truncate">{media?.filename || formatFileKind(mime)}</DialogTitle>
          <DialogDescription>
            {formatFileKind(mime)}
            {media?.blob?.size ? ` · ${formatBytes(media.blob.size)}` : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[72vh] min-h-32 items-center justify-center overflow-hidden rounded-md bg-black/90">
          {isImage && media?.url ? (
            <img src={media.url} alt={media.filename || 'Shared image'} className="max-h-[70vh] w-auto max-w-full object-contain" />
          ) : isVideo && media?.url ? (
            <video src={media.url} controls autoPlay className="max-h-[70vh] w-full" />
          ) : isAudio && media?.url ? (
            <div className="w-full p-8">
              <audio src={media.url} controls autoPlay className="w-full" />
            </div>
          ) : (
            <p className="p-8 text-sm text-white/80">This preview type is not supported. Download the file to open it.</p>
          )}
        </div>

        {media?.blob ? (
          <div className="flex justify-end">
            <Button type="button" variant="outline" onClick={() => downloadBlob(media.blob, media.filename || 'media')}>
              <Download aria-hidden="true" />
              Download
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

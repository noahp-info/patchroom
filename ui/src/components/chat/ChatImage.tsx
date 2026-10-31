import { useContext, useEffect, useState } from 'react';
import type { ChatImageRef } from '../../ipc';
import { ChatContext } from './ChatContext';

/** An image fetched on demand with `chat_image`. Bytes are never in the items. */
export function ChatImage({ image }: { image: ChatImageRef }) {
  const ctx = useContext(ChatContext);
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!ctx) return;
    let live = true;
    ctx.store.chatImage(ctx.sessionId, image.ref).then(
      (url) => {
        if (live) setSrc(url);
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [ctx, image.ref]);
  if (failed) return <span className="chatimg chatimg--missing">Image unavailable</span>;
  if (!src)
    return <span className="chatimg chatimg--loading" role="img" aria-label="Loading image" />;
  return <img className="chatimg" src={src} alt="Attached image" />;
}

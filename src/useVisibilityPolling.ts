import { useEffect } from 'react';

// Wait for each read to finish before scheduling the next one. Status updates
// change the cadence; hiding the page stops reads without closing its WebSocket.
export function useVisibilityPolling(read: () => Promise<void>, delay: number | null) {
  useEffect(() => {
    if (delay === null) return;
    let stopped = false;
    let reading = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      clearTimeout(timer);
      if (stopped || document.hidden || reading) return;
      reading = true;
      try { await read(); }
      finally {
        reading = false;
        if (!stopped && !document.hidden && Number.isFinite(delay)) timer = setTimeout(() => void tick(), delay);
      }
    };
    const visibility = () => { clearTimeout(timer); if (!document.hidden) void tick(); };
    document.addEventListener('visibilitychange', visibility);
    void tick();
    return () => { stopped = true; clearTimeout(timer); document.removeEventListener('visibilitychange', visibility); };
  }, [read, delay]);
}

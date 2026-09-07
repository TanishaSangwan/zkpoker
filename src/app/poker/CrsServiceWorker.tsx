'use client';

import { useEffect } from 'react';

/**
 * Registers public/crs-sw.js, which serves barretenberg's CRS from this
 * origin instead of crs.aztec.network.
 *
 * Mounted on the poker page rather than the root layout: it exists for
 * proving, and nothing else on the site proves.
 *
 * Registration is best-effort and deliberately quiet on failure. Without the
 * worker, bb.js fetches the points from Aztec directly -- which is what it
 * did before and works for most people; the worker is what makes it work for
 * a browser that will not trust that host's certificate. A registration
 * failure must not stop the page loading.
 */
export default function CrsServiceWorker() {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    // Scope '/' so it also controls the cross-origin CRS requests bb.js makes
    // from this page. A worker scoped to /poker would not see them.
    navigator.serviceWorker.register('/crs-sw.js', { scope: '/' }).catch(() => {});
  }, []);
  return null;
}

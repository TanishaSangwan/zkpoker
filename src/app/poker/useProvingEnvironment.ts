'use client';

// Cross-origin isolation, read after hydration.
//
// `provingEnvironment()` answers differently on the server (no `self`, no
// `navigator`) than in the browser, so reading it during render makes the
// server emit "1 thread, not isolated" and the client immediately replace it
// -- a hydration mismatch that React reports as a minified #418 and that hides
// real errors in the console. Reading it in an effect means the first paint
// matches the server and the truth arrives a tick later.

import { useEffect, useState } from 'react';
import { provingEnvironment, type ProvingEnvironment } from '@/lib/shuffle';

const SSR: ProvingEnvironment = { crossOriginIsolated: false, threads: 1, multithreaded: false };

export function useProvingEnvironment(): { env: ProvingEnvironment; ready: boolean } {
  const [env, setEnv] = useState<ProvingEnvironment>(SSR);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setEnv(provingEnvironment());
    setReady(true);
  }, []);
  return { env, ready };
}

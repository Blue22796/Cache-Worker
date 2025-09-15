export default {
  async fetch(request, env, ctx) {
    // Only handle GET/HEAD for caching
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return fetch(request);
    }

    // Don't cache requests that look user-specific / private
    if (request.headers.has('authorization') || request.headers.has('cookie')) {
      return fetch(request);
    }

    const cache = caches.default;
    // Normalize cache key to GET-only (avoid method differences)
    const cacheKey = new Request(request.url, { method: 'GET' });

    // Try to read from edge cache
    let cachedResponse = await cache.match(cacheKey);

    if (cachedResponse) {
      // Read our embedded timestamp header (set when we cached the response)
      const lastRefreshHeader = cachedResponse.headers.get('x-last-refresh');
      const lastRefresh = lastRefreshHeader ? Number(lastRefreshHeader) : 0;
      const now = Date.now();

      // If older than 30 minutes (30 * 60 * 1000 ms), refresh in background
      if (!lastRefresh || now - lastRefresh > 30 * 60 * 1000) {
        // Avoid awaiting: refresh in background
        ctx.waitUntil(refreshCache(request, cacheKey, cache));
      }

      // Serve the cached response immediately
      return cachedResponse;
    }

    // Cache miss -> fetch from origin, cache it (if ok), and return to user
    const originResponse = await fetch(request);

    // If response is ok, store it with x-last-refresh header
    if (originResponse.ok) {
      ctx.waitUntil(storeInCacheWithHeader(cacheKey, originResponse.clone(), cache));
    }

    return originResponse;
  }
};


// Refreshes the cache for cacheKey by fetching origin and storing with header.
// We keep this robust: only cache on success, catch errors.
async function refreshCache(request, cacheKey, cache) {
  try {
    const fresh = await fetch(request);

    if (!fresh.ok) {
      // don't overwrite cache with error responses
      return;
    }

    // clone and add x-last-refresh header
    const freshClone = fresh.clone();
    const headers = new Headers(freshClone.headers);
    headers.set('x-last-refresh', Date.now().toString());

    // Make a Response object that includes the modified headers
    const responseForCache = new Response(freshClone.body, {
      status: freshClone.status,
      statusText: freshClone.statusText,
      headers
    });

    // Put into the edge cache (no TTL parameter; cache-control header in response controls edge TTL)
    await cache.put(cacheKey, responseForCache.clone());
  } catch (err) {
    // Log or ignore — do not let this throw into the main request flow
    // In production you might use console.error or send telemetry
    console.error('refreshCache error:', err);
  }
}


// Store origin response in cache with x-last-refresh header
async function storeInCacheWithHeader(cacheKey, response, cache) {
  try {
    // Only cache OK responses
    if (!response.ok) return;

    const clone = response.clone();
    const headers = new Headers(clone.headers);
    headers.set('x-last-refresh', Date.now().toString());

    const responseForCache = new Response(clone.body, {
      status: clone.status,
      statusText: clone.statusText,
      headers
    });

    await cache.put(cacheKey, responseForCache.clone());
  } catch (err) {
    console.error('storeInCacheWithHeader error:', err);
  }
}

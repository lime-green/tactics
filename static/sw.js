/*
 * This is a Service Worker (sw) created to support these goals:
 *   1) Meet the criteria for an "Add to Home Screen" prompt for mobile devices.
 *   2) Will ultimately provide true offline mode for the game.
 *   3) Make it unnecessary to repeatedly download resources while developing.
 *
 * Note: This service worker disables all use of the traditional browser cache.
 * Rather, a custom cache is used that never expires, but may be replaced by
 * updating the service worker.
 */

// Application files are fetched and installed as a unit to ensure they are
// compatible with each other.  If a file can change between app versions and
// the change can break the app, it should be referenced here.
const APP_FILES = [
  '/',
  '/install.js',
  '/tactics.min.js',
  '/classic.html',
  '/classic-app.min.js',
  '/faceoff.html',
  '/faceoff-app.min.js',
  '/chaos.html',
  '/chaos-app.min.js',
  '/ww.min.js',
];

const DATE_INSTALLED = new Date().toISOString()
  .slice(0, 19)
  .replace(/[\-:]/g, '.')
  .replace('T', '_');

// The default version value is the date the app was installed.  This is good
// enough for development and testing, but should be replaced with a constant
// value when deploying the app so that all users have the same version value.
//
// Every change to application files should be represented as a version change.
const VERSION = DATE_INSTALLED;

// Application files are installed and cached with a version-specific name.  The
// currently installed app version remains unaffected while installing the new.
const INSTALL_CACHE_NAME = 'app'+(VERSION ? '-'+VERSION : '');

// Other files within the scope of this service worker are fetched and cached as
// needed.  They are not expected to change often or at all so this cache is
// shared between versions and is not normally cleared.  This cache is expected
// to contain image, sound, and data files or even 3rd-party dependencies.  The
// cache can be cleared manually by bumping the cache version for these reasons:
//   1) A minor change to a file has taken place (e.g. changing an image)
//   2) A file is moved from the fetch cache to the install cache.
//   3) One or more files are no longer used by a new app version.
const FETCH_CACHE_NAME = 'dynamic-v2';

const ACTIVE_CACHE_NAMES = [INSTALL_CACHE_NAME, FETCH_CACHE_NAME];

// Fetch all resources using these parameters.
const OPTIONS = {
  // Avoid caching resources in two places.
  cache: 'no-store',

  // Avoid problematic opaque responses.
  mode: 'cors',

  // No need to send or receive cookies.
  credentials: 'omit',
};

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(INSTALL_CACHE_NAME)
      .then(cache =>
        Promise.all(
          APP_FILES.map(url =>
            fetch(url, OPTIONS).then(response => {
              if (response && response.status === 200)
                return cache.put(url, response);
            })
          )
        )
      )
      .then(() => self.skipWaiting())
  )
});

/*
 * A cache hit is represented as: [cache, response]
 * A cache miss is represented as: [dynamicCache, null]
 *
 * Returns a promise, which resolves to a cache hit or cache miss.
 * The cache can be used to create or replace a request/response.
 */
function getCache(url) {
  return ACTIVE_CACHE_NAMES.reduce((promise, cacheName) =>
      promise.then(hit => hit ||
        caches.open(cacheName).then(cache =>
          cache.match(url).then(response => response && [cache, response])
        )
      ),
      Promise.resolve(),
    )
    .then(hit => hit ||
      caches.open(FETCH_CACHE_NAME).then(cache => [cache, null])
    );
}

self.addEventListener('fetch', event => {
  let url = event.request.url;

  event.respondWith(
    getCache(url).then(([cache, cachedResponse]) => {
      // Return cached response (unless it is a localhost URL)
      if (cachedResponse && !url.startsWith('http://localhost:2000/'))
        return cachedResponse;

      // Cache miss or localhost URL.  Fetch response and cache it.
      return fetch(url, OPTIONS)
        .then(response => {
          // Only cache successful responses.
          if (!response || response.status !== 200)
            return response;

          // Clone the response before the body is consumed.
          cache.put(url, response.clone());

          return response;
        })
        .catch(error => {
          // If a potentially stale locally hosted resource is cached, return it.
          if (cachedResponse)
            return cachedResponse;
          throw error;
        });
    })
  );
});

// Delete the dynamic cache and previous version caches.
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(cacheNames => {
        return Promise.all(
          cacheNames.map(cacheName => {
            if (ACTIVE_CACHE_NAMES.indexOf(cacheName) === -1)
              return caches.delete(cacheName);
          })
        );
      })
      // Since all game resources are fetched on page load, forcing clients to
      // use the new service worker would not affect fetched resources.  Rather,
      // this is done to inform clients that a new version is available via the
      // 'controllerchange' event.
      .then(() => clients.claim())
  );
});

self.addEventListener('message', event => {
  let client  = event.source;
  let message = event.data;

  if (message.type === 'getVersion')
    client.postMessage({
      type: 'version',
      version: VERSION,
    });
});

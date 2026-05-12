// En Garde — minimal app-shell SW.
// Caches the static shell so the app loads when wifi is bad at venues.
// Mutations go through the in-app offline queue (lib/offline.js), not the SW.

const SHELL_CACHE = 'en-garde-shell-v5';
const SHELL_FILES = [
    './',
    './index.html',
    './manifest.json',
    './css/style.css',
    './js/main.js',
    './js/lib/config.js',
    './js/lib/supa.js',
    './js/lib/auth.js',
    './js/lib/profile.js',
    './js/lib/router.js',
    './js/lib/db.js',
    './js/lib/util.js',
    './js/lib/state.js',
    './js/lib/offline.js',
    './js/lib/chips.js',
    './js/views/shell.js',
    './js/modules/dashboard.js',
    './js/modules/bouts.js',
    './js/modules/opponents.js',
    './js/modules/physical.js',
    './js/modules/mental.js',
    './js/modules/private_lessons.js',
    './js/modules/group_lessons.js',
    './js/modules/lessons.js',
    './js/modules/tournaments.js',
    './js/modules/import_v1.js'
];

self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(SHELL_CACHE).then((c) =>
            // best-effort: missing files don't block install
            Promise.all(SHELL_FILES.map((f) => c.add(f).catch(() => null)))
        )
    );
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', (e) => {
    const url = new URL(e.request.url);

    // never intercept Supabase API calls — those need to go to network or fail
    if (url.hostname.endsWith('supabase.co') || url.hostname.endsWith('supabase.in')) return;
    // never intercept Google fonts (they have their own caching)
    if (url.hostname.endsWith('googleapis.com') || url.hostname.endsWith('gstatic.com')) return;
    // only handle GETs from same origin
    if (e.request.method !== 'GET') return;
    if (url.origin !== self.location.origin) return;

    e.respondWith(
        caches.match(e.request).then((cached) => {
            if (cached) {
                // revalidate in background
                fetch(e.request)
                    .then((res) => {
                        if (res.ok) caches.open(SHELL_CACHE).then((c) => c.put(e.request, res));
                    })
                    .catch(() => {});
                return cached;
            }
            return fetch(e.request)
                .then((res) => {
                    if (res.ok) {
                        const clone = res.clone();
                        caches.open(SHELL_CACHE).then((c) => c.put(e.request, clone));
                    }
                    return res;
                })
                .catch(() => caches.match('./index.html'));
        })
    );
});

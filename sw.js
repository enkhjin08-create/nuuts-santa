// Самбарын апп суулгах боломжтой болгох энгийн service worker. Кэш хийхгүй, сүлжээгээр л дамжуулна.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});

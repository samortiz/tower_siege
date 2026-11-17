// Copies the game into www/ (the folder Capacitor packages into the APK) together with a local copy of PeerJS,
// so the Android app does not depend on a CDN to start multiplayer.
import { mkdirSync, copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
mkdirSync('www', { recursive: true });
copyFileSync('index.html', 'www/index.html');
copyFileSync(require.resolve('peerjs/dist/peerjs.min.js'), 'www/peerjs.min.js');
console.log('www/ ready');

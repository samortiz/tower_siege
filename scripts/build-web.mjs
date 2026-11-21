// Copies the game (index.html and the shared simulation, sim.js) into www/, the folder the game server serves
// and Capacitor packages into the APK.
import { mkdirSync, copyFileSync, rmSync } from 'node:fs';
mkdirSync('www', { recursive: true });
copyFileSync('index.html', 'www/index.html');
copyFileSync('sim.js', 'www/sim.js');
rmSync('www/peerjs.min.js', { force: true });   // left over from the PeerJS version of co-op
console.log('www/ ready');

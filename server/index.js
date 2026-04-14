// server/index.js
// ─────────────────────────────────────────────────────────────────────────────
// Main entry point for the Tab Out server.
// Serves the dashboard and API routes on localhost.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const { execSync } = require('child_process');
const config  = require('./config');
const { startUpdateChecker } = require('./updater');

// Dashboard ships as TypeScript compiled to dashboard/dist/. `npm start`
// runs the prestart build, but auto-start services (launchd/systemd) spawn
// `node server/index.js` directly and skip npm hooks. If the entry is
// missing at boot, run tsc inline — fail fast on build errors instead of
// serving a 404 to the browser.
const projectRoot = path.join(__dirname, '..');
const distEntry   = path.join(projectRoot, 'dashboard', 'dist', 'index.js');
if (!fs.existsSync(distEntry)) {
  console.log('[server] dashboard/dist/ missing, running `npm run build`...');
  try {
    execSync('npm run build', { cwd: projectRoot, stdio: 'inherit' });
  } catch (err) {
    console.error('[server] build failed; dashboard will not load. Run `npm run build` manually.');
    process.exit(1);
  }
}

const app = express();

// CORS: only allow requests from the Chrome extension iframe (localhost)
// and the extension's own origin. Block all other origins.
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  const allowed = !origin
    || origin.startsWith('http://localhost')
    || origin.startsWith('chrome-extension://');
  if (allowed) {
    res.header('Access-Control-Allow-Origin', origin || '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Parse JSON request bodies (for POST endpoints)
app.use(express.json());

// Serve the dashboard's static files (HTML, CSS, JS)
app.use(express.static(path.join(__dirname, '..', 'dashboard')));

// Mount API routes under /api
const apiRouter = require('./routes');
app.use('/api', apiRouter);

// Start the server
app.listen(config.port, () => {
  console.log(`Tab Out running at http://localhost:${config.port}`);
  startUpdateChecker();
});

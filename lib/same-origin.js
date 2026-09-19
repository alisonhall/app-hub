// Lightweight CSRF guard for app-hub's state-changing endpoints: app-hub has
// no auth (it's a local dev tool), so without this, any other page open in
// the same browser could POST to these routes. Browsers always send Origin
// on a cross-origin fetch/XHR; non-browser tools (curl, etc.) typically send
// none at all, so only a *present-but-mismatched* Origin is rejected.
function requireSameOrigin(req, res, next) {
  const origin = req.headers.origin;
  if (!origin) return next();
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    return res.status(403).json({ error: 'invalid Origin header' });
  }
  if (originHost !== req.headers.host) {
    return res.status(403).json({ error: 'cross-origin request rejected' });
  }
  next();
}

module.exports = { requireSameOrigin };

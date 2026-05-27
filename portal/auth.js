/* TLAPS Operations Portal — Auth Gate
 *
 * Synchronous, head-loaded gate that runs BEFORE page content renders.
 * Stores auth in sessionStorage (cleared when browser tab closes).
 *
 * Credentials are hashed with SHA-256. Cleartext passwords NEVER live in this file.
 * This is not high security — anyone who reads the source can read the hashes
 * and (with effort) brute-force them — but it blocks casual access.
 */

(function () {
  'use strict';

  // SHA-256 hashes of allowed passwords. Compute with:
  //   python3 -c "import hashlib; print(hashlib.sha256(b'PASSWORD').hexdigest())"
  var VALID_USERS = {
    'jcool009@hotmail.com':    '556c91c548097c5f136472289620ec6f4bfc9f9523b1aa9b9893a682f711bf67',
    'raypeng1118@hotmail.com': '102c7a6f67bd6f4718395ce080d9f95c848c78c334a437c664d992ad53528ae0'
  };

  var AUTH_KEY  = 'tlapsAuth';
  var EMAIL_KEY = 'tlapsAuthEmail';

  // Public API
  window.TLAPS_VALID_USERS = VALID_USERS;
  window.TLAPS_AUTH_KEY    = AUTH_KEY;
  window.TLAPS_EMAIL_KEY   = EMAIL_KEY;

  window.isAuthed = function () {
    try { return sessionStorage.getItem(AUTH_KEY) === 'true'; } catch (e) { return false; }
  };

  window.markAuthed = function (email) {
    try {
      sessionStorage.setItem(AUTH_KEY, 'true');
      sessionStorage.setItem(EMAIL_KEY, email || '');
    } catch (e) {}
  };

  window.signOut = function () {
    try {
      sessionStorage.removeItem(AUTH_KEY);
      sessionStorage.removeItem(EMAIL_KEY);
    } catch (e) {}
    // Bounce back to login regardless of current page
    window.location.replace('login.html');
  };

  // Hash a password using the browser SubtleCrypto API. Returns hex string.
  window.sha256Hex = async function (text) {
    var buf = new TextEncoder().encode(text);
    var hashBuf = await crypto.subtle.digest('SHA-256', buf);
    var bytes = new Uint8Array(hashBuf);
    var hex = '';
    for (var i = 0; i < bytes.length; i++) {
      var h = bytes[i].toString(16);
      if (h.length === 1) h = '0' + h;
      hex += h;
    }
    return hex;
  };

  // Try to log a user in. Resolves true on success, false on failure.
  window.attemptLogin = async function (email, password) {
    if (!email || !password) return false;
    var normEmail = String(email).trim().toLowerCase();
    var expected = VALID_USERS[normEmail];
    if (!expected) return false;
    var hash = await window.sha256Hex(String(password));
    if (hash === expected) {
      window.markAuthed(normEmail);
      return true;
    }
    return false;
  };

  // --- Gate ---
  // Identify the current page filename. If it's the login page or the auth
  // gate itself, do nothing. Otherwise: if unauthed, redirect to login.html
  // with ?next= preserving the original target.
  var path = window.location.pathname || '';
  var file = path.split('/').pop() || '';
  var lower = file.toLowerCase();

  // Pages that must NOT be gated (the login page itself)
  var OPEN_PAGES = ['login.html'];

  if (OPEN_PAGES.indexOf(lower) === -1) {
    if (!window.isAuthed()) {
      var here = window.location.pathname + window.location.search + window.location.hash;
      var nextParam = encodeURIComponent(here);
      // Use replace() so the gated page is not in browser history
      window.location.replace('login.html?next=' + nextParam);
    }
  }
})();

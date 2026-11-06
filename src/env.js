'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Loads a dotenv file without overriding values that are already present in
 * the environment. This keeps `MUSE_...=... node src/server.js` authoritative
 * over the file on disk.
 */
function loadDotEnv(file = path.join(process.cwd(), '.env')) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null) process.env[key] = value;
  }
}

function cookieHeaderFromJar(jar) {
  if (Array.isArray(jar)) {
    return jar
      .filter((cookie) => cookie && cookie.name && cookie.value)
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ');
  }
  if (jar && typeof jar === 'object') {
    return Object.entries(jar)
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }
  return '';
}

/**
 * Resolves the Muse cookie from the supported configuration forms:
 * full cookie string, hatch_sess (+ optional auxiliary cookies), or a JSON jar.
 */
function resolveCookie(env = process.env) {
  if (env.MUSE_COOKIE && env.MUSE_COOKIE.trim()) {
    return env.MUSE_COOKIE.trim();
  }
  if (env.MUSE_HATCH_SESS && env.MUSE_HATCH_SESS.trim()) {
    const parts = [`hatch_sess=${env.MUSE_HATCH_SESS.trim()}`];
    for (const name of ['hatch_gw', 'hatch_vml']) {
      const value = env[`MUSE_${name.toUpperCase()}`];
      if (value && value.trim()) parts.push(`${name}=${value.trim()}`);
    }
    return parts.join('; ');
  }
  const file = env.MUSE_COOKIES_FILE;
  if (file && fs.existsSync(file)) {
    const jar = JSON.parse(fs.readFileSync(file, 'utf8'));
    const header = cookieHeaderFromJar(jar);
    if (header) return header;
  }
  throw new Error(
    'Muse cookie not configured. Set MUSE_HATCH_SESS (value of the hatch_sess cookie), ' +
      'or MUSE_COOKIE (full cookie string), or MUSE_COOKIES_FILE (path to a cookies JSON).'
  );
}

module.exports = { loadDotEnv, resolveCookie, cookieHeaderFromJar };

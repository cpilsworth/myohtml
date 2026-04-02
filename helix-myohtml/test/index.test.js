import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import worker, { handleRequest } from '../src/index.js';

class MemoryKVNamespace {
  constructor() {
    this.store = new Map();
  }

  async get(key) {
    return this.store.get(key) ?? null;
  }

  async put(key, value) {
    this.store.set(key, value);
  }
}

const HOST_PAGE = `<!DOCTYPE html>
<html>
  <head>
    <title>Host Page</title>
    <meta name="description" content="host metadata">
  </head>
  <body>
    <header><p>Header</p></header>
    <main>
      <div><p>Intro</p></div>
      <div class="embed"><p><a href="https://allowed.example.com/imported/feature.html">Import</a></p></div>
      <div><p>Outro</p></div>
    </main>
    <footer><p>Footer</p></footer>
  </body>
</html>`;

const EMBED_PAGE = `<!DOCTYPE html>
<html>
  <head>
    <title>Imported Page</title>
    <meta name="description" content="ignored metadata">
    <script src="/ignored.js"></script>
  </head>
  <body>
    <main>
      <section class="hero">
        <a href="./download.pdf">Download</a>
        <img src="/media/card.png" alt="Card">
      </section>
    </main>
  </body>
</html>`;

const EMBED_WITHOUT_MAIN = '<html><body><p>No main here.</p></body></html>';

const RECURSIVE_EMBED = `<!DOCTYPE html>
<html>
  <body>
    <main>
      <section><p>Nested intro</p></section>
      <div class="embed"><p><a href="https://allowed.example.com/imported/deeper.html">Deeper</a></p></div>
    </main>
  </body>
</html>`;

const AUTO_ALLOWED_HOST_PAGE = `<!DOCTYPE html>
<html>
  <body>
    <main>
      <div class="embed"><p><a href="https://main--myohtml--cpilsworth.aem.live/fragments/hero.html">Hero</a></p></div>
    </main>
  </body>
</html>`;

let originalFetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('health endpoint returns readiness JSON', async () => {
  const response = await worker.fetch(
    new Request('https://composer.example.com/health'),
    { CONFIGS: new MemoryKVNamespace() },
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.status, 'ok');
});

test('POST /config stores normalized branch-aware config', async () => {
  const env = { CONFIGS: new MemoryKVNamespace() };

  const response = await handleRequest(
    new Request('https://composer.example.com/config/cpilsworth/myohtml/main', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        upstream: {
          baseUrl: 'https://da.example.com/content',
          forwardHeaders: ['Authorization'],
        },
        embeds: {
          allowedOrigins: ['https://allowed.example.com/some/path'],
          maxDepth: 3,
          timeoutMs: 2500,
          onError: 'omit',
        },
      }),
    }),
    env,
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.target, {
    org: 'cpilsworth',
    site: 'myohtml',
    branch: 'main',
  });
  assert.deepEqual(payload.config.embeds.allowedOrigins, ['https://allowed.example.com']);
});

test('POST /config accepts embed-only config for owner/site routes', async () => {
  const env = { CONFIGS: new MemoryKVNamespace() };

  const response = await handleRequest(
    new Request('https://composer.example.com/config/cpilsworth/myohtml/main', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        embeds: {
          allowedOrigins: ['https://allowed.example.com/some/path'],
          maxDepth: 3,
          timeoutMs: 2500,
          onError: 'omit',
        },
      }),
    }),
    env,
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.config.upstream, null);
  assert.deepEqual(payload.config.embeds.allowedOrigins, ['https://allowed.example.com']);
});

test('GET composes allowed embed content in place and preserves host chrome', async () => {
  const env = await configuredEnv();
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === 'https://da.example.com/content/articles/launch.html') {
      return htmlResponse(HOST_PAGE);
    }
    if (url === 'https://allowed.example.com/imported/feature.html') {
      return htmlResponse(EMBED_PAGE);
    }
    throw new Error(`Unexpected fetch to ${url}`);
  };

  const response = await handleRequest(
    new Request('https://composer.example.com/cpilsworth/myohtml/articles/launch.html'),
    env,
  );

  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /<title>Host Page<\/title>/);
  assert.match(html, /<header><p>Header<\/p><\/header>/);
  assert.match(html, /https:\/\/allowed\.example\.com\/imported\/download\.pdf/);
  assert.match(html, /https:\/\/allowed\.example\.com\/media\/card\.png/);
  assert.doesNotMatch(html, /ignored metadata/);
  assert.doesNotMatch(html, /<div class="embed">/);
});

test('non-allowlisted embed URLs are omitted without failing the page', async () => {
  const env = await configuredEnv({
    embeds: {
      allowedOrigins: ['https://safe.example.com'],
    },
  });
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === 'https://da.example.com/content/articles/launch.html') {
      return htmlResponse(HOST_PAGE);
    }
    throw new Error(`Unexpected fetch to ${url}`);
  };

  const response = await handleRequest(
    new Request('https://composer.example.com/cpilsworth/myohtml/articles/launch.html'),
    env,
  );

  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /Intro/);
  assert.match(html, /Outro/);
  assert.doesNotMatch(html, /Import/);
});

test('embed failures are soft-failed by omission', async () => {
  const env = await configuredEnv();
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === 'https://da.example.com/content/articles/launch.html') {
      return htmlResponse(HOST_PAGE);
    }
    if (url === 'https://allowed.example.com/imported/feature.html') {
      return htmlResponse(EMBED_WITHOUT_MAIN);
    }
    throw new Error(`Unexpected fetch to ${url}`);
  };

  const response = await handleRequest(
    new Request('https://composer.example.com/cpilsworth/myohtml/articles/launch.html'),
    env,
  );

  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /Intro/);
  assert.match(html, /Outro/);
  assert.doesNotMatch(html, /No main here/);
});

test('recursive embeds stop when maxDepth is reached', async () => {
  const env = await configuredEnv({
    embeds: {
      maxDepth: 1,
    },
  });
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === 'https://da.example.com/content/articles/launch.html') {
      return htmlResponse(HOST_PAGE);
    }
    if (url === 'https://allowed.example.com/imported/feature.html') {
      return htmlResponse(RECURSIVE_EMBED);
    }
    if (url === 'https://allowed.example.com/imported/deeper.html') {
      return htmlResponse(EMBED_PAGE);
    }
    throw new Error(`Unexpected fetch to ${url}`);
  };

  const response = await handleRequest(
    new Request('https://composer.example.com/cpilsworth/myohtml/articles/launch.html'),
    env,
  );

  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /Nested intro/);
  assert.doesNotMatch(html, /Download/);
});

test('site route derives upstream and auto-allows main preview/live origins', async () => {
  const env = {
    CONFIGS: new MemoryKVNamespace(),
  };

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === 'https://content.da.live/cpilsworth/myohtml/articles/launch.html') {
      return htmlResponse(AUTO_ALLOWED_HOST_PAGE);
    }
    if (url === 'https://main--myohtml--cpilsworth.aem.live/fragments/hero.html') {
      return htmlResponse(EMBED_PAGE);
    }
    throw new Error(`Unexpected fetch to ${url}`);
  };

  const response = await handleRequest(
    new Request('https://composer.example.com/cpilsworth/myohtml/articles/launch.html'),
    env,
  );

  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /Download/);
  assert.match(html, /https:\/\/main--myohtml--cpilsworth\.aem\.live\/fragments\/download\.pdf/);
});

async function configuredEnv(overrides = {}) {
  const env = {
    CONFIGS: new MemoryKVNamespace(),
  };

  const response = await handleRequest(
    new Request('https://composer.example.com/config/cpilsworth/myohtml/main', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        upstream: {
          baseUrl: 'https://da.example.com/content',
          forwardHeaders: ['Authorization'],
        },
        embeds: {
          allowedOrigins: ['https://allowed.example.com'],
          maxDepth: 2,
          timeoutMs: 3000,
          onError: 'omit',
          ...(overrides.embeds || {}),
        },
        ...(overrides.upstream ? { upstream: { ...overrides.upstream } } : {}),
      }),
    }),
    env,
  );

  assert.equal(response.status, 200);
  return env;
}

function htmlResponse(body) {
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=UTF-8',
    },
  });
}

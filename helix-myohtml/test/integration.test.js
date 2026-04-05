import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { handleRequest } from '../src/index.js';

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

const PAGE_WITH_PREVIEW_FRAGMENT = `<!DOCTYPE html>
<html>
  <body>
    <header><p>Header</p></header>
    <main>
      <div>
        <h1>Hello World</h1>
        <p>this is some text on the page</p>
        <div class="embed">
          <div>
            <div>
              <p><a href="https://main--myohtml--cpilsworth.aem.page/fragments/test">https://main--myohtml--cpilsworth.aem.page/fragments/test</a></p>
            </div>
          </div>
        </div>
      </div>
    </main>
    <footer><p>Footer</p></footer>
  </body>
</html>`;

const FRAGMENT_DOCUMENT = `<!DOCTYPE html>
<html>
  <body>
    <main>
      <div>
        <p>this is a test fragment</p>
      </div>
    </main>
  </body>
</html>`;

const FRAGMENT_WITH_RELATIVE_LINK = `<!DOCTYPE html>
<html>
  <body>
    <main>
      <div>
        <a href="./asset.pdf">Asset</a>
        <img src="/media/diagram.png" alt="Diagram">
      </div>
    </main>
  </body>
</html>`;

const PAGE_WITH_LIVE_FRAGMENT = `<!DOCTYPE html>
<html>
  <body>
    <main>
      <div class="embed">
        <p><a href="https://main--myohtml--cpilsworth.aem.live/fragments/test">Live fragment</a></p>
      </div>
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

test('integration: authenticated DA-style page request forwards auth upstream and composes preview fragment content', async () => {
  const env = await configuredEnv();
  const seenRequests = [];

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const headers = new Headers(init.headers);
    seenRequests.push({
      url,
      authorization: headers.get('Authorization'),
    });

    if (url === 'https://content.da.live/cpilsworth/myohtml/') {
      return htmlResponse(PAGE_WITH_PREVIEW_FRAGMENT);
    }

    if (url === 'https://main--myohtml--cpilsworth.aem.page/fragments/test') {
      return htmlResponse(FRAGMENT_DOCUMENT);
    }

    throw new Error(`Unexpected fetch to ${url}`);
  };

  const response = await handleRequest(
    new Request('https://composer.example.com/cpilsworth/myohtml/', {
      headers: {
        Authorization: 'Bearer test-da-token',
        'User-Agent': 'adobe-fetch/4.2.3',
        'X-Content-Source-Location': '/index',
      },
    }),
    env,
  );

  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /this is a test fragment/);
  assert.doesNotMatch(html, /<div class="embed">/);
  assert.equal(seenRequests[0].authorization, 'Bearer test-da-token');
  assert.equal(seenRequests[1].authorization, null);
});

test('integration: direct fragment route returns upstream fragment HTML untouched when there is no nested embed', async () => {
  const env = await configuredEnv();

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === 'https://content.da.live/cpilsworth/myohtml/fragments/test') {
      return htmlResponse(FRAGMENT_DOCUMENT);
    }

    throw new Error(`Unexpected fetch to ${url}`);
  };

  const response = await handleRequest(
    new Request('https://composer.example.com/cpilsworth/myohtml/fragments/test', {
      headers: {
        Authorization: 'Bearer test-da-token',
        'User-Agent': 'adobe-fetch/4.2.3',
        'X-Content-Source-Location': '/fragments/test',
      },
    }),
    env,
  );

  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /this is a test fragment/);
  assert.match(html, /<main>/);
});

test('integration: preview fragment links and assets are rebased against the fragment origin', async () => {
  const env = await configuredEnv();

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === 'https://content.da.live/cpilsworth/myohtml/') {
      return htmlResponse(PAGE_WITH_PREVIEW_FRAGMENT);
    }

    if (url === 'https://main--myohtml--cpilsworth.aem.page/fragments/test') {
      return htmlResponse(FRAGMENT_WITH_RELATIVE_LINK);
    }

    throw new Error(`Unexpected fetch to ${url}`);
  };

  const response = await handleRequest(
    new Request('https://composer.example.com/cpilsworth/myohtml/', {
      headers: {
        Authorization: 'Bearer test-da-token',
      },
    }),
    env,
  );

  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /https:\/\/main--myohtml--cpilsworth\.aem\.page\/fragments\/asset\.pdf/);
  assert.match(html, /https:\/\/main--myohtml--cpilsworth\.aem\.page\/media\/diagram\.png/);
});

test('integration: preview requests rewrite same-site fragment URLs to .aem.page', async () => {
  const env = await configuredEnv();
  const seenUrls = [];

  globalThis.fetch = async (input) => {
    const url = String(input);
    seenUrls.push(url);
    if (url === 'https://content.da.live/cpilsworth/myohtml/') {
      return htmlResponse(PAGE_WITH_LIVE_FRAGMENT);
    }

    if (url === 'https://main--myohtml--cpilsworth.aem.page/fragments/test') {
      return htmlResponse(FRAGMENT_DOCUMENT);
    }

    throw new Error(`Unexpected fetch to ${url}`);
  };

  const response = await handleRequest(
    new Request('https://composer.example.com/cpilsworth/myohtml/', {
      headers: {
        'X-Da-Mode': 'preview',
      },
    }),
    env,
  );

  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /this is a test fragment/);
  assert.ok(seenUrls.includes('https://main--myohtml--cpilsworth.aem.page/fragments/test'));
  assert.ok(!seenUrls.includes('https://main--myohtml--cpilsworth.aem.live/fragments/test'));
});

test('integration: publish requests rewrite same-site fragment URLs to .aem.live', async () => {
  const env = await configuredEnv();
  const seenUrls = [];

  globalThis.fetch = async (input) => {
    const url = String(input);
    seenUrls.push(url);
    if (url === 'https://content.da.live/cpilsworth/myohtml/') {
      return htmlResponse(PAGE_WITH_PREVIEW_FRAGMENT);
    }

    if (url === 'https://main--myohtml--cpilsworth.aem.live/fragments/test') {
      return htmlResponse(FRAGMENT_DOCUMENT);
    }

    throw new Error(`Unexpected fetch to ${url}`);
  };

  const response = await handleRequest(
    new Request('https://composer.example.com/cpilsworth/myohtml/', {
      headers: {
        'X-Da-Mode': 'publish',
      },
    }),
    env,
  );

  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /this is a test fragment/);
  assert.ok(seenUrls.includes('https://main--myohtml--cpilsworth.aem.live/fragments/test'));
  assert.ok(!seenUrls.includes('https://main--myohtml--cpilsworth.aem.page/fragments/test'));
});

test('integration: missing preview fragment is omitted without failing the host page', async () => {
  const env = await configuredEnv();

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === 'https://content.da.live/cpilsworth/myohtml/') {
      return htmlResponse(PAGE_WITH_PREVIEW_FRAGMENT);
    }

    if (url === 'https://main--myohtml--cpilsworth.aem.page/fragments/test') {
      return new Response('Not Found', {
        status: 404,
        headers: {
          'content-type': 'text/plain; charset=UTF-8',
        },
      });
    }

    throw new Error(`Unexpected fetch to ${url}`);
  };

  const response = await handleRequest(
    new Request('https://composer.example.com/cpilsworth/myohtml/', {
      headers: {
        Authorization: 'Bearer test-da-token',
      },
    }),
    env,
  );

  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /Hello World/);
  assert.doesNotMatch(html, /this is a test fragment/);
  assert.doesNotMatch(html, /<div class="embed">/);
});

test('integration: unauthenticated DA upstream failure returns 502 from the worker', async () => {
  const env = await configuredEnv();

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === 'https://content.da.live/cpilsworth/myohtml/') {
      return new Response('', {
        status: 401,
        headers: {
          'content-type': 'application/json',
        },
      });
    }

    throw new Error(`Unexpected fetch to ${url}`);
  };

  const response = await handleRequest(
    new Request('https://composer.example.com/cpilsworth/myohtml/'),
    env,
  );

  const body = await response.json();
  assert.equal(response.status, 502);
  assert.equal(body.upstreamStatus, 401);
  assert.deepEqual(body.target, {
    org: 'cpilsworth',
    site: 'myohtml',
    branch: 'main',
  });
});

test('spec: backend preview and publish requests compose embedded fragment content', async () => {
  const env = await configuredEnv();
  const seenUrls = [];

  globalThis.fetch = async (input) => {
    const url = String(input);
    seenUrls.push(url);
    if (url === 'https://content.da.live/cpilsworth/myohtml/') {
      return htmlResponse(PAGE_WITH_PREVIEW_FRAGMENT);
    }

    if (
      url === 'https://main--myohtml--cpilsworth.aem.page/fragments/test'
      || url === 'https://main--myohtml--cpilsworth.aem.live/fragments/test'
    ) {
      return htmlResponse(FRAGMENT_DOCUMENT);
    }

    throw new Error(`Unexpected fetch to ${url}`);
  };

  for (const mode of ['preview', 'publish']) {
    const response = await handleRequest(
      new Request('https://composer.example.com/cpilsworth/myohtml/', {
        headers: {
          Authorization: 'Bearer test-da-token',
          'User-Agent': 'adobe-fetch/4.2.3',
          'X-Da-Mode': mode,
        },
      }),
      env,
    );

    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /this is a test fragment/);
    assert.doesNotMatch(html, /<div class="embed">/);
  }

  assert.ok(seenUrls.includes('https://main--myohtml--cpilsworth.aem.page/fragments/test'));
  assert.ok(seenUrls.includes('https://main--myohtml--cpilsworth.aem.live/fragments/test'));
});

async function configuredEnv() {
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
        embeds: {
          allowedOrigins: ['https://json2html.adobeaem.workers.dev'],
          maxDepth: 2,
          timeoutMs: 3000,
          onError: 'omit',
        },
        plugins: [],
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

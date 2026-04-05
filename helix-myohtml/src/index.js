import {
  buildImplicitSiteConfig,
  ensureConfigWriteAuthorized,
  ensureRippleEventAuthorized,
  isContentUpdatedEventRoute,
  isConfigRoute,
  loadConfig,
  parseConfigRoute,
  parseDefaultTarget,
  parseSitePath,
  parseTenantPath,
  storeConfig,
} from './lib/config.js';
import { composePage, fetchUpstreamPage } from './lib/compose.js';
import { createExtensionRuntime } from './lib/extensions.js';

const LOGGED_REQUEST_HEADERS = [
  'accept',
  'accept-language',
  'host',
  'origin',
  'referer',
  'user-agent',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'sec-fetch-user',
];

const LOGGED_UPSTREAM_HEADERS = [
  'content-type',
  'etag',
  'last-modified',
  'x-da-actions',
  'x-da-child-actions',
  'x-da-id',
];

const REDACTED_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'cf-access-jwt-assertion',
  'x-api-key',
]);

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      if (error instanceof Response) {
        return error;
      }

      console.error(JSON.stringify({
        message: 'Unhandled request failure.',
        error: error instanceof Error ? error.stack || error.message : String(error),
      }));

      return json(
        {
          error: 'Internal Server Error',
        },
        500,
      );
    }
  },
};

export async function handleRequest(request, env) {
  const url = new URL(request.url);

  if (url.pathname === '/health') {
    return json({
      status: 'ok',
      service: 'helix-myohtml',
      time: new Date().toISOString(),
    });
  }

  if (request.method === 'POST' && isConfigRoute(url.pathname)) {
    return handleConfigWrite(request, env, url.pathname);
  }

  if (request.method === 'POST' && isContentUpdatedEventRoute(url.pathname)) {
    return handleContentUpdatedEvent(request, env);
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ error: 'Method Not Allowed' }, 405, {
      Allow: 'GET,HEAD,POST',
    });
  }

  return handleContentRequest(request, env, url.pathname);
}

async function handleConfigWrite(request, env, pathname) {
  ensureConfigWriteAuthorized(request, env);

  const target = parseConfigRoute(pathname);
  const body = await request.json();
  const config = await storeConfig(env, target, body);

  return json({
    ok: true,
    target,
    config,
  });
}

async function handleContentRequest(request, env, pathname) {
  const resolved = await resolveConfigForRequest(env, pathname);
  if (!resolved) {
    return json({ error: 'No matching config found.' }, 404);
  }

  const { target, config, contentPath } = resolved;
  const extensions = createExtensionRuntime({
    env,
    target,
    config,
    contentPath,
  });
  const requestLogContext = {
    event: 'content_request',
    request: describeRequest(request, pathname),
    resolved: {
      target,
      contentPath,
      upstreamBaseUrl: config.upstream.baseUrl,
      allowedOrigins: config.embeds.allowedOrigins,
      maxDepth: config.embeds.maxDepth,
      plugins: extensions.activePluginNames,
    },
  };

  console.log(JSON.stringify(requestLogContext));

  const { upstreamUrl, response } = await fetchUpstreamPage({
    request,
    contentPath,
    config,
  });

  console.log(JSON.stringify({
    event: 'upstream_fetch',
    request: {
      method: request.method,
      pathname,
    },
    upstream: {
      url: upstreamUrl,
      status: response.status,
      ok: response.ok,
      headers: pickHeaders(response.headers, LOGGED_UPSTREAM_HEADERS),
    },
  }));

  if (!response.ok) {
    return json(
      {
        error: 'Failed to fetch upstream DA page.',
        upstreamStatus: response.status,
        target,
      },
      502,
    );
  }

  const html = await response.text();
  const composed = await composePage({
    request,
    html,
    upstreamUrl,
    config,
    target,
    hooks: {
      onEmbedResolved: (embedUrl) => extensions.trackDependency(embedUrl),
    },
  });
  await extensions.finalizeComposition();

  if (request.method === 'HEAD') {
    return new Response(null, {
      status: response.status,
      headers: responseHeaders(response.headers),
    });
  }

  return new Response(composed, {
    status: response.status,
    headers: responseHeaders(response.headers),
  });
}

async function handleContentUpdatedEvent(request, env) {
  ensureRippleEventAuthorized(request, env);

  const body = await request.json();
  const owner = body?.owner;
  const site = body?.site;
  const branch = body?.branch || 'main';
  const path = body?.path;
  const action = body?.action || 'preview';

  if (!owner || !site || !path) {
    return json({
      error: 'owner, site, and path are required.',
    }, 400);
  }

  if (!['preview', 'publish'].includes(action)) {
    return json({
      error: 'action must be "preview" or "publish".',
    }, 400);
  }

  const target = { org: owner, site, branch };
  const storedConfig = env?.CONFIGS ? await loadConfig(env, target) : null;
  const config = buildImplicitSiteConfig(owner, site, storedConfig);
  const extensions = createExtensionRuntime({
    env,
    target,
    config,
    contentPath: path,
  });

  const ripple = await extensions.planContentUpdate({ path, action });

  return json({
    ok: true,
    event: {
      owner,
      site,
      branch,
      path,
      action,
    },
    plugins: extensions.activePluginNames,
    ripple: {
      mode: 'plan',
      ...ripple,
    },
  });
}

async function resolveConfigForRequest(env, pathname) {
  const siteRoute = parseSitePath(pathname);
  if (siteRoute) {
    const storedConfig = env?.CONFIGS
      ? await loadConfig(env, siteRoute.target)
      : null;

    return {
      target: siteRoute.target,
      contentPath: siteRoute.contentPath,
      config: buildImplicitSiteConfig(siteRoute.owner, siteRoute.site, storedConfig),
    };
  }

  const tenantRoute = parseTenantPath(pathname);
  if (tenantRoute) {
    const config = await loadConfig(env, tenantRoute.target);
    if (config) {
      return {
        ...tenantRoute,
        config,
      };
    }
  }

  const defaultTarget = parseDefaultTarget(env);
  if (!defaultTarget) {
    return null;
  }

  const config = await loadConfig(env, defaultTarget);
  if (!config) {
    return null;
  }

  return {
    target: defaultTarget,
    contentPath: pathname || '/',
    config,
  };
}

function responseHeaders(sourceHeaders) {
  const headers = new Headers(sourceHeaders);
  headers.set('content-type', 'text/html; charset=UTF-8');
  headers.delete('content-length');
  return headers;
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=UTF-8',
      ...extraHeaders,
    },
  });
}

function describeRequest(request, pathname) {
  const url = new URL(request.url);

  return {
    method: request.method,
    url: request.url,
    pathname,
    host: url.host,
    search: url.search,
    headers: pickHeaders(request.headers, LOGGED_REQUEST_HEADERS),
    cf: pickCfProperties(request.cf),
  };
}

function pickHeaders(headers, names) {
  const output = {};

  for (const name of names) {
    const value = headers.get(name);
    if (!value) {
      continue;
    }

    output[name] = REDACTED_HEADERS.has(name) ? '[redacted]' : value;
  }

  return output;
}

function pickCfProperties(cf) {
  if (!cf) {
    return null;
  }

  return {
    asOrganization: cf.asOrganization ?? null,
    asn: cf.asn ?? null,
    city: cf.city ?? null,
    colo: cf.colo ?? null,
    continent: cf.continent ?? null,
    country: cf.country ?? null,
    httpProtocol: cf.httpProtocol ?? null,
    metroCode: cf.metroCode ?? null,
    postalCode: cf.postalCode ?? null,
    region: cf.region ?? null,
    regionCode: cf.regionCode ?? null,
    timezone: cf.timezone ?? null,
  };
}

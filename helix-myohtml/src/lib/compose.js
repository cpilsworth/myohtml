import { buildAutoAllowedOrigins } from './config.js';
import {
  extractFirstHref,
  extractMain,
  findEmbedBlocks,
  rebaseRelativeUrls,
  replaceMain,
  stripImportedMarkup,
} from './html.js';

export async function composePage({
  request,
  html,
  upstreamUrl,
  config,
  target = null,
  hooks = {},
}) {
  const main = extractMain(html);
  if (!main) {
    return html;
  }

  const composedMain = await composeFragment({
    request,
    fragment: main.innerHtml,
    baseUrl: upstreamUrl,
    config,
    depth: 0,
    target,
    hooks,
  });

  return replaceMain(html, composedMain);
}

export async function fetchUpstreamPage({ request, contentPath, config }) {
  const upstreamUrl = joinUpstreamUrl(config.upstream.baseUrl, contentPath, new URL(request.url).search);
  const headers = buildForwardHeaders(request, config.upstream.forwardHeaders);
  const response = await fetch(upstreamUrl, {
    method: 'GET',
    headers,
  });

  return {
    upstreamUrl,
    response,
  };
}

async function composeFragment({ request, fragment, baseUrl, config, depth, target, hooks }) {
  const embedBlocks = findEmbedBlocks(fragment);
  if (!embedBlocks.length) {
    return fragment;
  }

  let output = '';
  let cursor = 0;

  for (const block of embedBlocks) {
    output += fragment.slice(cursor, block.start);
    output += await resolveEmbedBlock({
      request,
      blockHtml: block.html,
      parentUrl: baseUrl,
      config,
      depth,
      target,
      hooks,
    });
    cursor = block.end;
  }

  output += fragment.slice(cursor);
  return output;
}

async function resolveEmbedBlock({
  request,
  blockHtml,
  parentUrl,
  config,
  depth,
  target,
  hooks,
}) {
  const nextDepth = depth + 1;
  if (nextDepth > config.embeds.maxDepth) {
    return '';
  }

  const href = extractFirstHref(blockHtml);
  if (!href) {
    return '';
  }

  const embedUrl = rewriteSameSiteEmbedUrl(new URL(href, parentUrl), request, target);
  if (!config.embeds.allowedOrigins.includes(embedUrl.origin)) {
    return '';
  }

  if (typeof hooks.onEmbedResolved === 'function') {
    await hooks.onEmbedResolved(embedUrl.href);
  }

  try {
    const response = await fetchWithTimeout(embedUrl.href, config.embeds.timeoutMs);
    if (!response.ok) {
      throw new Error(`Embed fetch failed with status ${response.status}.`);
    }

    const importedHtml = await response.text();
    const main = extractMain(importedHtml);
    if (!main) {
      throw new Error('Embed document did not contain a <main> element.');
    }

    const responseUrl = response.url || embedUrl.href;
    const cleaned = stripImportedMarkup(main.innerHtml);
    const recursivelyComposed = await composeFragment({
      request,
      fragment: cleaned,
      baseUrl: responseUrl,
      config,
      depth: nextDepth,
      target,
      hooks,
    });

    return rebaseRelativeUrls(recursivelyComposed, responseUrl);
  } catch (error) {
    if (config.embeds.onError === 'omit') {
      console.warn(JSON.stringify({
        message: 'Embed omitted during composition.',
        embedUrl: embedUrl.href,
        error: error instanceof Error ? error.message : String(error),
      }));
      return '';
    }

    throw error;
  }
}

function buildForwardHeaders(request, forwardHeaders) {
  const headers = new Headers();
  for (const headerName of forwardHeaders) {
    const value = request.headers.get(headerName);
    if (value) {
      headers.set(headerName, value);
    }
  }
  return headers;
}

function joinUpstreamUrl(baseUrl, contentPath, search = '') {
  const url = new URL(baseUrl);
  const prefix = url.pathname.replace(/\/$/, '');
  const suffix = contentPath.startsWith('/') ? contentPath : `/${contentPath}`;
  url.pathname = `${prefix}${suffix}`.replace(/\/{2,}/g, '/');
  url.search = search;
  url.hash = '';
  return url.toString();
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Timed out while fetching embed.')), timeoutMs);

  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function rewriteSameSiteEmbedUrl(embedUrl, request, target) {
  if (!target) {
    return embedUrl;
  }

  const desiredOrigin = resolveDesiredSameSiteOrigin(request, target);
  if (!desiredOrigin) {
    return embedUrl;
  }

  const sameSiteOrigins = new Set([
    ...buildAutoAllowedOrigins(target.org, target.site),
    'https://content.da.live',
  ]);

  if (!sameSiteOrigins.has(embedUrl.origin)) {
    return embedUrl;
  }

  if (embedUrl.origin === 'https://content.da.live') {
    const prefix = `/${target.org}/${target.site}`;
    if (!embedUrl.pathname.startsWith(prefix)) {
      return embedUrl;
    }

    const rewritten = new URL(embedUrl.toString());
    rewritten.protocol = new URL(desiredOrigin).protocol;
    rewritten.host = new URL(desiredOrigin).host;
    rewritten.pathname = embedUrl.pathname.slice(prefix.length) || '/';
    return rewritten;
  }

  const rewritten = new URL(embedUrl.toString());
  rewritten.protocol = new URL(desiredOrigin).protocol;
  rewritten.host = new URL(desiredOrigin).host;
  return rewritten;
}

function resolveDesiredSameSiteOrigin(request, target) {
  const previewOrigin = `https://main--${target.site}--${target.org}.aem.page`;
  const liveOrigin = `https://main--${target.site}--${target.org}.aem.live`;

  const explicitMode = normalizeModeHint(request.headers.get('x-da-mode'));
  if (explicitMode === 'preview') {
    return previewOrigin;
  }
  if (explicitMode === 'live') {
    return liveOrigin;
  }

  for (const headerName of ['referer', 'origin']) {
    const value = request.headers.get(headerName);
    if (!value) {
      continue;
    }

    const hostMode = inferModeFromHost(safeHostname(value));
    if (hostMode === 'preview') {
      return previewOrigin;
    }
    if (hostMode === 'live') {
      return liveOrigin;
    }
  }

  const forwardedHostMode = inferModeFromHost(request.headers.get('x-forwarded-host'));
  if (forwardedHostMode === 'preview') {
    return previewOrigin;
  }
  if (forwardedHostMode === 'live') {
    return liveOrigin;
  }

  return null;
}

function normalizeModeHint(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['preview', 'author', 'edit', 'editor'].includes(normalized)) {
    return 'preview';
  }
  if (['publish', 'live', 'production'].includes(normalized)) {
    return 'live';
  }
  return null;
}

function inferModeFromHost(hostname) {
  const normalized = String(hostname || '').toLowerCase();
  if (normalized.includes('.aem.page')) {
    return 'preview';
  }
  if (normalized.includes('.aem.live')) {
    return 'live';
  }
  return null;
}

function safeHostname(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return value;
  }
}

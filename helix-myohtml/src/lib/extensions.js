import { buildAutoAllowedOrigins } from './config.js';

const PAGE_DEPENDENCY_PREFIX = 'deps:v1:page:';
const SOURCE_DEPENDENCY_PREFIX = 'deps:v1:source:';
const EMBED_RIPPLE_PLUGIN = 'embed-ripple';

export function createExtensionRuntime({ env, target, config, contentPath }) {
  const activePlugins = getActivePlugins(config);
  const trackedDependencies = new Set();

  return {
    activePluginNames: activePlugins.map((plugin) => plugin.name),

    trackDependency(embedUrl) {
      if (!hasPlugin(activePlugins, EMBED_RIPPLE_PLUGIN)) {
        return;
      }

      trackedDependencies.add(embedUrl);
    },

    async finalizeComposition() {
      if (!hasPlugin(activePlugins, EMBED_RIPPLE_PLUGIN)) {
        return;
      }

      await persistPageDependencies(env, {
        target,
        pagePath: contentPath,
        sourceUrls: [...trackedDependencies],
      });
    },

    async planContentUpdate({ path, action = 'preview' }) {
      if (!hasPlugin(activePlugins, EMBED_RIPPLE_PLUGIN)) {
        return {
          plugin: EMBED_RIPPLE_PLUGIN,
          affectedPages: [],
          action,
        };
      }

      const affectedPages = await loadAffectedPagesForSource(env, {
        target,
        changedPath: path,
      });

      return {
        plugin: EMBED_RIPPLE_PLUGIN,
        affectedPages,
        action,
      };
    },
  };
}

async function persistPageDependencies(env, { target, pagePath, sourceUrls }) {
  if (!env?.DEPENDENCIES) {
    return;
  }

  const normalizedPagePath = normalizePath(pagePath);
  const pageKey = buildPageDependencyKey(target, normalizedPagePath);
  const previousSourceIds = await readJsonArray(env.DEPENDENCIES, pageKey);
  const nextSourceIds = [...new Set(sourceUrls.flatMap((url) => identifySourceIds(url, target)))];

  for (const sourceId of previousSourceIds) {
    if (nextSourceIds.includes(sourceId)) {
      continue;
    }

    const pages = await readJsonArray(env.DEPENDENCIES, buildSourceDependencyKey(sourceId));
    const nextPages = pages.filter((candidate) => candidate !== normalizedPagePath);
    await env.DEPENDENCIES.put(
      buildSourceDependencyKey(sourceId),
      JSON.stringify(nextPages),
    );
  }

  for (const sourceId of nextSourceIds) {
    const sourceKey = buildSourceDependencyKey(sourceId);
    const pages = await readJsonArray(env.DEPENDENCIES, sourceKey);
    const nextPages = [...new Set([...pages, normalizedPagePath])].sort();
    await env.DEPENDENCIES.put(sourceKey, JSON.stringify(nextPages));
  }

  await env.DEPENDENCIES.put(pageKey, JSON.stringify(nextSourceIds.sort()));
}

async function loadAffectedPagesForSource(env, { target, changedPath }) {
  if (!env?.DEPENDENCIES) {
    return [];
  }

  const sourceIds = buildChangedSourceIds(target, changedPath);
  const pages = new Set();

  for (const sourceId of sourceIds) {
    const pageList = await readJsonArray(env.DEPENDENCIES, buildSourceDependencyKey(sourceId));
    for (const page of pageList) {
      pages.add(page);
    }
  }

  return [...pages].sort();
}

function buildChangedSourceIds(target, changedPath) {
  const normalizedPath = normalizePath(changedPath);
  return [
    buildSitePathSourceId(target, normalizedPath),
  ];
}

function identifySourceIds(sourceUrl, target) {
  const parsed = new URL(sourceUrl);
  const sitePath = mapSitePathFromUrl(parsed, target);
  const ids = [`url:${parsed.href}`];

  if (sitePath) {
    ids.push(buildSitePathSourceId(target, sitePath));
  }

  return ids;
}

function mapSitePathFromUrl(url, target) {
  const autoAllowedOrigins = new Set(buildAutoAllowedOrigins(target.org, target.site));
  if (autoAllowedOrigins.has(url.origin)) {
    return normalizePath(url.pathname);
  }

  if (url.origin !== 'https://content.da.live') {
    return null;
  }

  const sitePrefix = `/${target.org}/${target.site}`;
  if (!url.pathname.startsWith(sitePrefix)) {
    return null;
  }

  const remainder = url.pathname.slice(sitePrefix.length);
  return normalizePath(remainder || '/');
}

function buildSitePathSourceId(target, path) {
  return `site-path:${target.org}/${target.site}/${target.branch}${normalizePath(path)}`;
}

function buildPageDependencyKey(target, pagePath) {
  return `${PAGE_DEPENDENCY_PREFIX}${target.org}/${target.site}/${target.branch}${normalizePath(pagePath)}`;
}

function buildSourceDependencyKey(sourceId) {
  return `${SOURCE_DEPENDENCY_PREFIX}${encodeURIComponent(sourceId)}`;
}

async function readJsonArray(namespace, key) {
  const raw = await namespace.get(key);
  if (!raw) {
    return [];
  }

  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

function getActivePlugins(config) {
  return (config.plugins || []).filter((plugin) => plugin.enabled);
}

function hasPlugin(plugins, name) {
  return plugins.some((plugin) => plugin.name === name);
}

function normalizePath(path) {
  if (!path) {
    return '/';
  }

  return `/${String(path).replace(/^\/+/, '')}`.replace(/\/+/g, '/');
}

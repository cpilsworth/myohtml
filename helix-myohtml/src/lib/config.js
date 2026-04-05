const CONFIG_PREFIX = 'config:v1:';
const DEFAULT_FORWARD_HEADERS = ['Authorization'];
const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_ON_ERROR = 'omit';

export function buildConfigKey({ org, site, branch }) {
  return `${CONFIG_PREFIX}${org}/${site}/${branch}`;
}

export function normalizeStoredConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Config body must be a JSON object.');
  }

  const upstream = normalizeUpstream(input.upstream);
  const embeds = normalizeEmbeds(input.embeds);
  const plugins = normalizePlugins(input.plugins);

  return { upstream, embeds, plugins };
}

export async function loadConfig(env, target) {
  if (!env?.CONFIGS) {
    throw new Error('Missing CONFIGS KV binding.');
  }

  const raw = await env.CONFIGS.get(buildConfigKey(target));
  if (!raw) {
    return null;
  }

  return normalizeStoredConfig(JSON.parse(raw));
}

export async function storeConfig(env, target, input) {
  if (!env?.CONFIGS) {
    throw new Error('Missing CONFIGS KV binding.');
  }

  const config = normalizeStoredConfig(input);
  await env.CONFIGS.put(buildConfigKey(target), JSON.stringify(config));
  return config;
}

export function parseTenantPath(pathname) {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length < 3) {
    return null;
  }

  const [org, site, branch, ...rest] = segments;
  const contentPath = `/${rest.join('/')}`.replace(/\/+/g, '/');

  return {
    target: { org, site, branch },
    contentPath: rest.length ? contentPath : '/',
  };
}

export function parseSitePath(pathname) {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length < 2 || segments[0] === 'config') {
    return null;
  }

  const [owner, site, ...rest] = segments;
  const contentPath = `/${rest.join('/')}`.replace(/\/+/g, '/');

  return {
    owner,
    site,
    target: { org: owner, site, branch: 'main' },
    contentPath: rest.length ? contentPath : '/',
  };
}

export function parseDefaultTarget(env) {
  const value = env?.DEFAULT_CONFIG;
  if (!value) {
    return null;
  }

  const [org, site, branch] = value.split('/').filter(Boolean);
  if (!org || !site || !branch) {
    throw new Error('DEFAULT_CONFIG must be formatted as "<org>/<site>/<branch>".');
  }

  return { org, site, branch };
}

export function isConfigRoute(pathname) {
  const segments = pathname.split('/').filter(Boolean);
  return segments.length === 4 && segments[0] === 'config';
}

export function isContentUpdatedEventRoute(pathname) {
  return pathname === '/events/content-updated';
}

export function parseConfigRoute(pathname) {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length !== 4 || segments[0] !== 'config') {
    return null;
  }

  const [, org, site, branch] = segments;
  return { org, site, branch };
}

export function ensureConfigWriteAuthorized(request, env) {
  ensureWriteAuthorized(request, env?.CONFIG_API_TOKEN);
}

export function ensureRippleEventAuthorized(request, env) {
  ensureWriteAuthorized(request, env?.RIPPLE_API_TOKEN);
}

export function buildImplicitSiteConfig(owner, site, storedConfig = null) {
  const config = {
    upstream: storedConfig?.upstream ?? {
      baseUrl: `https://content.da.live/${owner}/${site}`,
      forwardHeaders: DEFAULT_FORWARD_HEADERS,
    },
    embeds: {
      allowedOrigins: dedupeOrigins([
        ...(storedConfig?.embeds?.allowedOrigins || []),
        ...buildAutoAllowedOrigins(owner, site),
      ]),
      maxDepth: storedConfig?.embeds?.maxDepth ?? DEFAULT_MAX_DEPTH,
      timeoutMs: storedConfig?.embeds?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      onError: storedConfig?.embeds?.onError ?? DEFAULT_ON_ERROR,
    },
    plugins: storedConfig?.plugins ?? [],
  };

  return normalizeStoredConfig(config);
}

export function buildAutoAllowedOrigins(owner, site) {
  return [
    `https://main--${site}--${owner}.aem.page`,
    `https://main--${site}--${owner}.aem.live`,
  ];
}

function normalizeUpstream(input) {
  if (input == null) {
    return null;
  }

  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('upstream must be an object when provided.');
  }

  if (!input.baseUrl || typeof input.baseUrl !== 'string') {
    throw new TypeError('Config requires upstream.baseUrl.');
  }

  const baseUrl = new URL(input.baseUrl).toString().replace(/\/$/, '');
  const forwardHeaders = normalizeHeaderList(input.forwardHeaders);

  return {
    baseUrl,
    forwardHeaders,
  };
}

function normalizeEmbeds(input) {
  if (input == null) {
    return {
      allowedOrigins: [],
      maxDepth: DEFAULT_MAX_DEPTH,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      onError: DEFAULT_ON_ERROR,
    };
  }

  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('embeds must be an object when provided.');
  }

  const allowedOrigins = Array.isArray(input.allowedOrigins)
    ? input.allowedOrigins.map((value) => normalizeOrigin(value))
    : [];

  const maxDepth = normalizePositiveInteger(
    input.maxDepth,
    DEFAULT_MAX_DEPTH,
    'embeds.maxDepth',
  );

  const timeoutMs = normalizePositiveInteger(
    input.timeoutMs,
    DEFAULT_TIMEOUT_MS,
    'embeds.timeoutMs',
  );

  const onError = input.onError ?? DEFAULT_ON_ERROR;
  if (onError !== 'omit') {
    throw new TypeError('Only embeds.onError="omit" is supported in v1.');
  }

  return {
    allowedOrigins,
    maxDepth,
    timeoutMs,
    onError,
  };
}

function normalizeHeaderList(input) {
  if (input == null) {
    return [];
  }

  if (!Array.isArray(input) || input.some((value) => typeof value !== 'string')) {
    throw new TypeError('Header lists must be arrays of strings.');
  }

  return input.map((value) => value.trim()).filter(Boolean);
}

function normalizeOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError('allowedOrigins entries must be non-empty strings.');
  }

  return new URL(value).origin;
}

function normalizePositiveInteger(value, fallback, fieldName) {
  if (value == null) {
    return fallback;
  }

  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${fieldName} must be a non-negative integer.`);
  }

  return value;
}

function dedupeOrigins(values) {
  return [...new Set(values)];
}

function normalizePlugins(input) {
  if (input == null) {
    return [];
  }

  if (!Array.isArray(input)) {
    throw new TypeError('plugins must be an array when provided.');
  }

  return input.map((plugin) => normalizePlugin(plugin));
}

function normalizePlugin(input) {
  if (typeof input === 'string' && input.trim()) {
    return {
      name: input.trim(),
      enabled: true,
      config: {},
    };
  }

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('plugins entries must be strings or objects.');
  }

  if (!input.name || typeof input.name !== 'string') {
    throw new TypeError('plugins entries require a string name.');
  }

  if (input.enabled != null && typeof input.enabled !== 'boolean') {
    throw new TypeError('plugins.enabled must be a boolean when provided.');
  }

  if (input.config != null && (typeof input.config !== 'object' || Array.isArray(input.config))) {
    throw new TypeError('plugins.config must be an object when provided.');
  }

  return {
    name: input.name.trim(),
    enabled: input.enabled ?? true,
    config: input.config ?? {},
  };
}

function ensureWriteAuthorized(request, expectedToken) {
  if (!expectedToken) {
    return;
  }

  const rawAuthorization = request.headers.get('authorization') || '';
  const normalized = rawAuthorization.trim();
  const accepted = [
    `Bearer ${expectedToken}`,
    `token ${expectedToken}`,
  ];

  if (!accepted.includes(normalized)) {
    throw new Response(JSON.stringify({ error: 'Unauthorized.' }), {
      status: 401,
      headers: {
        'content-type': 'application/json; charset=UTF-8',
      },
    });
  }
}

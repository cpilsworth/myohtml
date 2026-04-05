# `helix-myohtml` Design

This document explains what the service does, how requests move through it, how configuration and composition work, and how a simple extension system can support ripple-style updates when shared content changes.

## What This Service Is

`helix-myohtml` is an experimental Cloudflare Worker that composes multiple content sources into a single BYOM HTML response.

The primary use case is:

- DA owns the page shell and the page source path
- authors place `embed` blocks in DA content
- the Worker resolves those embeds
- preview/live consumers receive one composed HTML document

The Worker is not trying to replace DA, replace BYOM, or become a full rendering platform. Its job is narrower:

- fetch the host DA HTML
- preserve the host page shell
- inline allowed remote content into `<main>`
- return the composed result

## Mental Model

The simplest way to understand the service is:

1. DA provides the page.
2. The Worker treats the DA page as the host document.
3. The Worker looks for `embed` blocks inside `<main>`.
4. Each embed points to another HTML document.
5. The Worker extracts only that document’s `<main>` content.
6. The Worker replaces the original embed block with the imported content.

Everything outside `<main>` remains owned by the host page.

That means:

- the DA page stays authoritative for `<html>`, `<head>`, `<body>`, `<header>`, `<footer>`, and page metadata
- imported documents contribute content only
- imported `<head>` data is ignored

## Current Request Model

The Worker supports four important request shapes.

### `GET /health`

Readiness check.

### `POST /config/:org/:site/:branch`

Stores branch-scoped site configuration in KV.

This follows the same operational pattern as other small Helix-style admin endpoints:

- config writes are server-side
- config is branch-aware
- write authorization is token-based

If `CONFIG_API_TOKEN` is set, the request must send one of:

- `Authorization: Bearer <token>`
- `Authorization: token <token>`

### `GET /:owner/:site/<content-path>`

This is the main content route.

For example:

```text
/cpilsworth/myohtml/fragments/test
```

The Worker infers:

- `owner = cpilsworth`
- `site = myohtml`
- `branch = main`
- upstream base URL = `https://content.da.live/cpilsworth/myohtml`

This route works even if there is no stored site config. KV is optional here.

### `POST /events/content-updated`

This is the new ripple planning route.

It accepts a description of a changed source and returns the pages that should be reprocessed.

Example:

```json
{
  "owner": "cpilsworth",
  "site": "myohtml",
  "branch": "main",
  "path": "/fragments/test",
  "action": "preview"
}
```

If `RIPPLE_API_TOKEN` is set, it uses the same auth pattern as config writes:

- `Authorization: Bearer <token>`
- `Authorization: token <token>`

Current behavior is intentionally limited:

- it computes a ripple plan
- it does not yet execute real preview or publish side effects

## Composition Flow

The runtime flow for a normal page request is:

1. Parse the request path.
2. Resolve the site target.
3. Load stored config from KV if present.
4. Build the effective config.
5. Fetch the upstream DA page.
6. Parse out the host `<main>`.
7. Find `embed` blocks.
8. For each embed:
   - read the first link
   - check that the URL origin is allowed
   - fetch the remote HTML
   - extract remote `<main>`
   - strip imported noise such as scripts
   - recursively compose nested embeds up to `maxDepth`
   - rebase relative URLs against the imported document URL
9. Replace the embed block in the host main content.
10. Reassemble the host document with the composed `<main>`.
11. Return the final HTML response.

The important design choice is that composition is local to `<main>`.

That keeps the system predictable:

- host page shell remains stable
- imported content cannot rewrite the host page metadata
- imported content is treated as content, not as full-document authority

## Configuration Model

The core stored config lives in the `CONFIGS` KV namespace.

### Minimal stored config

For owner/site routes, upstream is inferred, so the minimal config can be:

```json
{
  "embeds": {
    "allowedOrigins": [
      "https://fragments.example.com"
    ],
    "maxDepth": 2,
    "timeoutMs": 3000,
    "onError": "omit"
  }
}
```

### Effective config

At runtime the Worker augments that config with:

- inferred upstream `https://content.da.live/<owner>/<site>`
- auto-allowed preview/live origins:
  - `https://main--<site>--<owner>.aem.page`
  - `https://main--<site>--<owner>.aem.live`

That means `allowedOrigins` should be read as:

- explicit extra origins the site wants to trust

not:

- every origin needed for the Worker to operate

### Optional plugin config

The config model now also supports:

```json
{
  "plugins": [
    {
      "name": "embed-ripple",
      "enabled": true,
      "config": {
        "mode": "plan"
      }
    }
  ]
}
```

This is intentionally conservative.

The config selects built-in behavior by name. It does not upload code or execute arbitrary scripts.

## Authentication And Authorization

Configuration changes are protected with a simple admin token model.

That is intentionally close to the operational style used by `json2html`:

- token-based writes
- no user/session model in the Worker itself
- the Worker trusts callers that possess the configured admin token

In `helix-myohtml` there are two independent write controls:

- `CONFIG_API_TOKEN`
  - protects config changes
- `RIPPLE_API_TOKEN`
  - protects ripple planning events

If these are unset, the corresponding endpoints are open. In practice they should be set for any shared environment.

## Extension System

The extension system is deliberately small.

This Worker does not need a general plugin marketplace. It needs a narrow mechanism to attach extra behavior to the composition pipeline.

### Why an extension system exists at all

The base service only needs to compose HTML.

But once composition works, a useful next step is understanding dependency relationships such as:

- page A embeds fragment X
- page B embeds fragment X
- if fragment X changes, page A and page B should be refreshed

That logic is not part of basic HTML composition. It is a sidecar concern.

That is the purpose of the extension system.

### Design goals

- keep the main composition pipeline simple
- keep extension code built into the Worker
- allow site config to opt into behavior by name
- support dependency capture and ripple planning without coupling immediately to publish logic

### Current extension runtime

The implementation in [src/lib/extensions.js](./src/lib/extensions.js) currently does three things:

1. determines which plugins are active for the request
2. records embed dependencies during composition
3. computes a ripple plan from a source update event

The current built-in extension is:

- `embed-ripple`

## Dependency Recording

When `embed-ripple` is enabled, the Worker records relationships between:

- a page path
- the sources it embedded

This data lives in an optional `DEPENDENCIES` KV namespace.

### Why this is needed

To ripple content changes, the system must answer:

> Which pages depend on this changed source?

That requires a reverse dependency index.

### What gets stored

The Worker maintains two logical indexes:

- page-to-sources
- source-to-pages

That allows both:

- page inspection
- reverse lookup on source updates

### Source identities

The system currently tracks two kinds of source identity.

#### Absolute URL identity

For any external source:

```text
url:https://example.com/fragments/hero
```

#### Normalized site-path identity

For same-site DA/preview/live sources:

```text
site-path:cpilsworth/myohtml/main/fragments/test
```

This normalization is important because the same logical source may appear through:

- `content.da.live`
- `.aem.page`
- `.aem.live`

The ripple system needs one stable identity for those.

## Ripple Planning

The current event route does not publish anything directly.

That is a deliberate boundary.

### What it does now

Given a changed source path such as `/fragments/test`, the Worker:

1. normalizes the source identity
2. looks up reverse dependencies in `DEPENDENCIES`
3. returns the affected page paths

Example response shape:

```json
{
  "ok": true,
  "event": {
    "owner": "cpilsworth",
    "site": "myohtml",
    "branch": "main",
    "path": "/fragments/test",
    "action": "preview"
  },
  "plugins": ["embed-ripple"],
  "ripple": {
    "mode": "plan",
    "plugin": "embed-ripple",
    "action": "preview",
    "affectedPages": [
      "/",
      "/articles/launch.html"
    ]
  }
}
```

### Why it is plan-only

The hard part of ripple is not dependency discovery. The hard part is the side effect.

Specifically:

- what system emits authoritative content update events?
- what API or workflow should refresh preview?
- what API or workflow should publish?
- how should retries, dedupe, and ordering work?

Those decisions are environment-specific.

So the current design stops at the cleanest reusable seam:

- identify affected pages
- return a plan

That gives you a stable interface for later integration with:

- DA webhooks
- a queue
- a Sidekick action
- a dedicated publish orchestrator

## How This Can Be Extended

There are several sane ways to extend this without turning the Worker into something too large.

### 1. More built-in plugins

The simplest path is to add more built-in plugin names.

Examples:

- `embed-ripple`
  - track dependencies and compute affected pages
- `path-filter`
  - only apply composition on certain content paths
- `source-rewriter`
  - normalize or rewrite certain embed URLs before fetch
- `publish-gate`
  - block publish ripple unless certain checks pass

This keeps trust boundaries strong because config only enables known code.

### 2. Queue-backed ripple execution

Once the plan endpoint is trusted, a next step is:

1. `POST /events/content-updated`
2. compute affected pages
3. enqueue jobs
4. worker or queue consumer triggers preview/publish side effects

That would let the system scale without doing long-running publish operations inside the request path.

### 3. Dependency inspection APIs

For debugging, it would be useful to expose:

- `GET /deps/page/:owner/:site/:branch/<path>`
- `GET /deps/source/:owner/:site/:branch/<path>`

That would help answer:

- why did this page republish?
- why did this source not trigger any pages?

### 4. Path-scoped composition policies

The same extension model could support:

- only composing certain sections
- only enabling ripple for certain sections
- using different plugin sets per site or branch

That is likely the closest analogue to how `json2html` scopes behavior by path rules.

## File-Level Overview

The most important files are:

- [src/index.js](./src/index.js)
  - request routing
  - health/config/content/event endpoints
  - composition orchestration
- [src/lib/config.js](./src/lib/config.js)
  - config normalization
  - route parsing
  - auth helpers
  - implicit site config derivation
- [src/lib/compose.js](./src/lib/compose.js)
  - host page fetch
  - embed resolution
  - recursive composition
- [src/lib/extensions.js](./src/lib/extensions.js)
  - plugin activation
  - dependency persistence
  - ripple planning
- [test/index.test.js](./test/index.test.js)
  - route, config, plugin, and ripple plan tests
- [test/integration.test.js](./test/integration.test.js)
  - integration-style composition tests

## Tradeoffs And Limits

The current design intentionally favors simplicity over completeness.

### Strengths

- easy to reason about
- low operational complexity
- host page remains authoritative
- extension model is controlled and safe
- ripple can be added incrementally

### Limitations

- full documents are buffered in memory
- imported `<head>` content is ignored
- no backend distinction between DA authoring and preview/live
- ripple is plan-only today
- dependency storage in KV is simple but not ideal for high-cardinality graphs

If the dependency graph grows or ripple becomes critical infrastructure, D1 would likely be a better fit than KV.

## Recommended Next Steps

If you want to evolve this from prototype to a more complete system, the next steps should be:

1. decide what authoritative content update event should call `/events/content-updated`
2. add a queue-backed executor for ripple plans
3. make publish execution opt-in and explicit
4. add dependency inspection endpoints for debugging
5. consider D1 if reverse dependency volume grows

That sequence keeps the system incremental and understandable while preserving the core composition behavior.

# `myohtml` Research Plan

## Summary

Create a new top-level research folder named `helix-myohtml/` that documents and prototypes the design for a Cloudflare Worker acting as the primary [BYOM source](https://www.aem.live/developer/byom) for an EDS site. The worker will fetch the upstream DA content-bus HTML for the requested page, parse it, find DA `embed` blocks, and replace each one with normalized `<main>` content fetched from an allowlisted HTML source such as [json2html](https://www.aem.live/developer/json2html) or another BYOM-compatible document source.

This plan treats the worker as the page composer, not as an EDS overlay. EDS should point at the worker as the content source, and the worker should in turn pull DA HTML plus embedded remote HTML, compose the final semantic page, and return BYOM-friendly HTML.

## Key Changes

### Research folder contents

Add a new sibling folder `helix-myohtml/` with:

- `README.md`: architecture, request flow, authoring contract, config model, failure behavior, and rollout notes.
- `examples/da-page-with-embed.html`: minimal DA-origin page showing an `embed` block linking to a remote HTML document.
- `examples/embedded-source.html`: sample imported HTML document whose `<main>` content is inserted.
- `examples/composed-output.html`: expected BYOM HTML after composition.
- `examples/config.json`: sample per-site config for upstream DA source, allowlisted embed origins, and header forwarding.
- `diagrams/request-flow.mmd`: request/response flow from EDS -> worker -> DA content bus + remote embeds.

### Service shape

Plan the service as a Cloudflare Worker with these external interfaces:

- `GET /<content-path>`: returns fully composed BYOM HTML for the requested page path.
- `POST /config/:org/:site/:branch`: stores branch-aware config, mirroring the operational style of `json2html`.
- `GET /health`: basic health/readiness response.

Document this config shape as the default interface:

```json
{
  "upstream": {
    "baseUrl": "https://<da-content-bus-origin>",
    "forwardHeaders": ["Authorization"]
  },
  "embeds": {
    "allowedOrigins": [
      "https://json2html.adobeaem.workers.dev"
    ],
    "maxDepth": 2,
    "timeoutMs": 3000,
    "onError": "omit"
  }
}
```

### Composition behavior

Define the worker behavior precisely:

- For each incoming page request, fetch the matching DA HTML page from the configured content-bus base URL using the same path.
- Parse the returned HTML and preserve the host page shell: `<html>`, `<head>`, `<body>`, `<header>`, `<footer>`, and page-level metadata stay owned by the DA page.
- Inside `<main>`, detect `embed` blocks and treat the first link in the block as the embed source URL.
- Only fetch embed URLs whose origin matches the configured allowlist.
- For each fetched embed document, extract its `<main>` element only.
- Replace the original DA `embed` block with the top-level children of the imported `<main>`, preserving order in the host page.
- Strip imported `<head>`, metadata, scripts, and any duplicate page chrome; imported documents contribute body content only.
- Rebase relative asset/document URLs in imported markup against the imported document origin before insertion.
- Do not recursively import indefinitely; stop at `maxDepth`.
- If an embed fetch, parse, allowlist check, or `<main>` extraction fails, omit that embed from output and continue rendering the page.

### Authoring contract

Lock the DA authoring contract to keep implementation simple:

- Authors use a DA `embed` block whose first link points to an HTML document to inline.
- The linked document must itself be valid BYOM-style HTML with a `<main>` element.
- The worker does not support arbitrary selectors or partial-fragment extraction in v1; it imports the referenced document’s normalized `<main>` content only.
- Cross-origin embeds are supported only through explicit allowlisting.

## Test Plan

Cover these cases in the research examples and planned implementation tests:

- Page with no `embed` blocks returns DA HTML unchanged except for normalization.
- Single `embed` block imports one remote document’s `<main>` content in place.
- Multiple `embed` blocks preserve source order in the composed output.
- Imported relative `src` and `href` values are rebased correctly.
- Non-allowlisted embed URL is skipped.
- Remote document without `<main>` is skipped.
- Remote timeout or 4xx/5xx response is skipped without failing the page.
- Recursive embed chain stops at the configured max depth.
- Host page metadata remains from DA only; imported document metadata is ignored.

## Assumptions And Defaults

- The worker is configured as the primary BYOM content source because page composition requires full control of the returned HTML.
- Upstream DA content bus can return HTML for the same path EDS requests.
- `embed` block parsing uses the first anchor as the canonical source URL.
- Default runtime is Cloudflare Worker.
- Default trust model is allowlisted origins only.
- Default failure policy is soft-fail by omission.
- Imported content is limited to `<main>` content only; no v1 support for fragment selectors, author-defined merge strategies, or imported head metadata.

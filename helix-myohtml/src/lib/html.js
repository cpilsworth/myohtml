const MAIN_PATTERN = /<main\b([^>]*)>([\s\S]*?)<\/main>/i;
const SCRIPT_PATTERN = /<script\b[\s\S]*?<\/script>/gi;
const HEAD_NOISE_PATTERN = /<(?:meta|title|base|link)\b[^>]*>/gi;

export function extractMain(html) {
  const match = MAIN_PATTERN.exec(html);
  if (!match) {
    return null;
  }

  return {
    fullMatch: match[0],
    attributes: match[1] || '',
    innerHtml: match[2],
  };
}

export function replaceMain(html, replacement) {
  return html.replace(MAIN_PATTERN, (_match, attributes) => `<main${attributes}>${replacement}</main>`);
}

export function stripImportedMarkup(html) {
  return html.replace(SCRIPT_PATTERN, '').replace(HEAD_NOISE_PATTERN, '');
}

export function rebaseRelativeUrls(html, baseUrl) {
  return html.replace(/\b(href|src)\s*=\s*("([^"]*)"|'([^']*)')/gi, (match, attributeName, quotedValue, doubleQuoted, singleQuoted) => {
    const rawValue = doubleQuoted ?? singleQuoted ?? '';
    if (!shouldRebase(rawValue)) {
      return match;
    }

    const absoluteUrl = new URL(rawValue, baseUrl).href;
    const quote = quotedValue[0];
    return `${attributeName}=${quote}${absoluteUrl}${quote}`;
  });
}

export function extractFirstHref(html) {
  const match = html.match(/\bhref\s*=\s*("([^"]*)"|'([^']*)')/i);
  return match ? (match[2] ?? match[3] ?? null) : null;
}

export function findEmbedBlocks(html) {
  const blocks = [];
  let index = 0;

  while (index < html.length) {
    const openIndex = html.indexOf('<', index);
    if (openIndex === -1) {
      break;
    }

    if (html.startsWith('<!--', openIndex)) {
      const commentEnd = html.indexOf('-->', openIndex + 4);
      index = commentEnd === -1 ? html.length : commentEnd + 3;
      continue;
    }

    const tagEnd = findTagEnd(html, openIndex);
    if (tagEnd === -1) {
      break;
    }

    const tagSource = html.slice(openIndex, tagEnd);
    const tag = parseTag(tagSource);
    if (!tag || tag.closing) {
      index = tagEnd;
      continue;
    }

    if (hasClass(tagSource, 'embed')) {
      const blockEnd = tag.selfClosing ? tagEnd : findMatchingClose(html, tag.name, tagEnd);
      if (blockEnd === -1) {
        break;
      }

      blocks.push({
        start: openIndex,
        end: blockEnd,
        html: html.slice(openIndex, blockEnd),
      });
      index = blockEnd;
      continue;
    }

    index = tagEnd;
  }

  return blocks;
}

function hasClass(tagSource, className) {
  const classValue = getAttributeValue(tagSource, 'class');
  if (!classValue) {
    return false;
  }

  return classValue.split(/\s+/).includes(className);
}

function getAttributeValue(tagSource, attributeName) {
  const escapedName = escapeForRegExp(attributeName);
  const pattern = new RegExp(
    `\\b${escapedName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\\x60]+))`,
    'i',
  );
  const match = pattern.exec(tagSource);
  if (!match) {
    return null;
  }

  return match[1] ?? match[2] ?? match[3] ?? null;
}

function findMatchingClose(html, tagName, startIndex) {
  let depth = 1;
  let index = startIndex;

  while (index < html.length) {
    const nextOpen = html.indexOf('<', index);
    if (nextOpen === -1) {
      return -1;
    }

    if (html.startsWith('<!--', nextOpen)) {
      const commentEnd = html.indexOf('-->', nextOpen + 4);
      index = commentEnd === -1 ? html.length : commentEnd + 3;
      continue;
    }

    const nextTagEnd = findTagEnd(html, nextOpen);
    if (nextTagEnd === -1) {
      return -1;
    }

    const tagSource = html.slice(nextOpen, nextTagEnd);
    const tag = parseTag(tagSource);
    if (!tag) {
      index = nextTagEnd;
      continue;
    }

    if (tag.name !== tagName) {
      index = nextTagEnd;
      continue;
    }

    if (tag.closing) {
      depth -= 1;
      if (depth === 0) {
        return nextTagEnd;
      }
    } else if (!tag.selfClosing) {
      depth += 1;
    }

    index = nextTagEnd;
  }

  return -1;
}

function parseTag(tagSource) {
  const match = /^<\s*(\/)?\s*([A-Za-z][\w:-]*)/.exec(tagSource);
  if (!match) {
    return null;
  }

  return {
    closing: Boolean(match[1]),
    name: match[2].toLowerCase(),
    selfClosing: /\/\s*>$/.test(tagSource),
  };
}

function findTagEnd(html, startIndex) {
  let quote = null;

  for (let index = startIndex + 1; index < html.length; index += 1) {
    const character = html[index];
    if (quote) {
      if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (character === '"' || character === '\'') {
      quote = character;
      continue;
    }

    if (character === '>') {
      return index + 1;
    }
  }

  return -1;
}

function shouldRebase(value) {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return !(
    normalized.startsWith('http://')
    || normalized.startsWith('https://')
    || normalized.startsWith('//')
    || normalized.startsWith('data:')
    || normalized.startsWith('mailto:')
    || normalized.startsWith('tel:')
    || normalized.startsWith('javascript:')
    || normalized.startsWith('#')
  );
}

function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

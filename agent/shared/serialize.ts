/**
 * QaisDebugs — turns anything a `console.*` call received into a JSON-safe value.
 *
 * Depth- and size-limited, circular-safe, and keeps the useful parts of the things people log
 * most: errors (name, message, stack and own fields such as `status`), dates, URLs, maps, sets.
 */

export interface SerializeOptions {
  maxDepth?: number;
  maxItems?: number;
  maxString?: number;
}

const DEFAULTS: Required<SerializeOptions> = { maxDepth: 5, maxItems: 100, maxString: 4000 };

export function toSerializable(value: unknown, options: SerializeOptions = {}): unknown {
  const settings = { ...DEFAULTS, ...options };

  return walk(value, 0, settings, new WeakSet<object>());
}

function walk(value: unknown, depth: number, settings: Required<SerializeOptions>, seen: WeakSet<object>): unknown {
  switch (typeof value) {
    case 'string':
      return truncate(value, settings.maxString);
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'boolean':
      return value;
    case 'undefined':
      return '[undefined]';
    case 'bigint':
      return `${value}n`;
    case 'symbol':
      return value.toString();
    case 'function':
      return `[Function: ${value.name || 'anonymous'}]`;
    default:
      break;
  }

  if (value === null) return null;

  const object = value as object;

  if (seen.has(object)) return '[Circular]';

  if (object instanceof Error) {
    seen.add(object);
    const own: Record<string, unknown> = {};
    for (const key of Object.keys(object)) {
      own[key] = walk((object as unknown as Record<string, unknown>)[key], depth + 1, settings, seen);
    }

    return { name: object.name, message: object.message, stack: object.stack, ...own };
  }

  if (object instanceof Date) return Number.isNaN(object.getTime()) ? 'Invalid Date' : object.toISOString();
  if (object instanceof RegExp) return object.toString();
  if (typeof URL !== 'undefined' && object instanceof URL) return object.href;
  if (object instanceof ArrayBuffer) return `[ArrayBuffer ${object.byteLength} bytes]`;
  if (ArrayBuffer.isView(object)) return `[${object.constructor.name} ${object.byteLength} bytes]`;
  if (typeof Promise !== 'undefined' && object instanceof Promise) return '[Promise]';
  if (isDomNode(object)) return describeNode(object);
  if (typeof window !== 'undefined' && object === window) return '[Window]';

  if (depth >= settings.maxDepth) {
    return Array.isArray(object) ? `[Array(${object.length})]` : `[${constructorName(object)}]`;
  }

  seen.add(object);

  if (typeof Headers !== 'undefined' && object instanceof Headers) {
    const entries: Record<string, string> = {};
    object.forEach((headerValue, name) => {
      entries[name] = headerValue;
    });

    return entries;
  }

  if (object instanceof Map) {
    return walk(Array.from(object.entries()), depth, settings, seen);
  }

  if (object instanceof Set) {
    return walk(Array.from(object.values()), depth, settings, seen);
  }

  if (Array.isArray(object)) {
    const items = object.slice(0, settings.maxItems).map((item) => walk(item, depth + 1, settings, seen));
    if (object.length > settings.maxItems) {
      items.push(`[+${object.length - settings.maxItems} more]`);
    }

    return items;
  }

  const toJSON = (object as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === 'function') {
    try {
      return walk(toJSON.call(object), depth + 1, settings, seen);
    } catch {
      // Fall through to the plain-object path.
    }
  }

  const out: Record<string, unknown> = {};
  const keys = Object.keys(object);

  for (const key of keys.slice(0, settings.maxItems)) {
    try {
      out[key] = walk((object as Record<string, unknown>)[key], depth + 1, settings, seen);
    } catch {
      // A getter that throws (a closed stream, a cross-origin frame).
      out[key] = '[unreadable]';
    }
  }

  if (keys.length > settings.maxItems) {
    out['…'] = `[+${keys.length - settings.maxItems} more keys]`;
  }

  return out;
}

interface DomNodeLike {
  nodeType: number;
  nodeName: string;
  id?: string;
  className?: unknown;
}

/** Browser DOM nodes: logged often, enormous when walked. */
function isDomNode(object: object): object is DomNodeLike {
  const node = object as Partial<DomNodeLike>;

  return typeof node.nodeType === 'number' && typeof node.nodeName === 'string';
}

function describeNode(node: DomNodeLike): string {
  if (node.nodeType !== 1) return `[${node.nodeName}]`;
  const id = node.id ? `#${node.id}` : '';
  const classes = typeof node.className === 'string' && node.className.trim() ? `.${node.className.trim().split(/\s+/).join('.')}` : '';

  return `<${node.nodeName.toLowerCase()}${id}${classes}>`;
}

function constructorName(object: object): string {
  const name = object.constructor?.name;

  return name && name !== 'Object' ? name : 'Object';
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [+${text.length - max} chars]` : text;
}

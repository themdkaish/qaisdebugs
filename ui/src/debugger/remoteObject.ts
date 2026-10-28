/** Rendering helpers for CDP `Runtime.RemoteObject` values. */

export interface RemoteObject {
  type: string;
  subtype?: string;
  className?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  objectId?: string;
  preview?: { properties?: Array<{ name: string; value?: string; type: string }>; overflow?: boolean; description?: string };
}

export interface PropertyDescriptor {
  name: string;
  value?: RemoteObject;
  get?: RemoteObject;
  isOwn?: boolean;
}

export function describe(object: RemoteObject | undefined): string {
  if (!object) return 'undefined';
  if (object.unserializableValue) return object.unserializableValue;

  switch (object.type) {
    case 'string':
      return JSON.stringify(object.value);
    case 'undefined':
      return 'undefined';
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(object.value ?? object.description ?? '');
    case 'symbol':
    case 'function':
      return object.description ?? object.type;
    default:
      break;
  }

  if (object.subtype === 'null') return 'null';
  if (object.preview?.properties) {
    const inner = object.preview.properties
      .slice(0, 5)
      .map((property) => `${property.name}: ${property.value ?? property.type}`)
      .join(', ');
    const more = object.preview.overflow ? ', …' : '';

    return object.subtype === 'array' ? `[${inner}${more}]` : `${object.className && object.className !== 'Object' ? `${object.className} ` : ''}{${inner}${more}}`;
  }

  return object.description ?? object.className ?? object.type;
}

export function isExpandable(object: RemoteObject | undefined): boolean {
  return Boolean(object?.objectId) && object?.type === 'object' && object.subtype !== 'null';
}

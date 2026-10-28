import { randomUUID } from 'node:crypto';

/** A unique id for events and spans. */
export function newId(): string {
  return randomUUID();
}

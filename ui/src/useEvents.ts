import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentEvent, DevtoolsEvent, RequestEvent } from './events';
import { mergeRequest } from './mergeRequests';

export interface EventsFeed {
  events: DevtoolsEvent[];
  /** The dev servers running now: the latest announcement from each app's agent. */
  agents: AgentEvent[];
  connected: boolean;
  paused: boolean;
  pendingWhilePaused: number;
  clear: () => Promise<void>;
  togglePause: () => void;
}

const MAX_EVENTS = 5000;

/** Subscribes to the collector's SSE stream and keeps a bounded, de-duplicated event list. */
export function useEvents(): EventsFeed {
  const [events, setEvents] = useState<DevtoolsEvent[]>([]);
  const [agents, setAgents] = useState<AgentEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(false);
  const [pendingWhilePaused, setPendingWhilePaused] = useState(0);
  const pausedRef = useRef(false);
  const pendingRef = useRef<DevtoolsEvent[]>([]);
  const seenRef = useRef(new Set<string>());

  // The collector sends the whole list whenever it changes, so a stopped dev server disappears.
  const replaceAgents = useCallback((list: AgentEvent[]) => {
    setAgents([...list].sort((a, b) => a.app.localeCompare(b.app)));
  }, []);

  const append = useCallback((batch: DevtoolsEvent[]) => {
    const fresh: DevtoolsEvent[] = [];
    // A request recorded by both the page script and the dev server arrives twice under one id.
    const halves = new Map<string, RequestEvent>();
    for (const event of batch) {
      if (event.kind === 'agent') continue;
      if (!seenRef.current.has(event.id)) {
        seenRef.current.add(event.id);
        fresh.push(event);
      } else if (event.kind === 'request') {
        const known = fresh.find((candidate) => candidate.id === event.id);
        if (known?.kind === 'request') fresh[fresh.indexOf(known)] = mergeRequest(known, event);
        else halves.set(event.id, halves.has(event.id) ? mergeRequest(halves.get(event.id) as RequestEvent, event) : event);
      }
    }
    if (fresh.length === 0 && halves.size === 0) return;

    setEvents((previous) => {
      const merged = halves.size ? previous.map((event) => (event.kind === 'request' && halves.has(event.id) ? mergeRequest(event, halves.get(event.id) as RequestEvent) : event)) : previous;
      const next = merged.concat(fresh);
      if (next.length > MAX_EVENTS) {
        for (const dropped of next.slice(0, next.length - MAX_EVENTS)) seenRef.current.delete(dropped.id);

        return next.slice(next.length - MAX_EVENTS);
      }

      return next;
    });
  }, []);

  useEffect(() => {
    const source = new EventSource('/events');

    source.addEventListener('hello', (message) => {
      setConnected(true);
      try {
        const payload = JSON.parse((message as MessageEvent<string>).data) as { agents?: AgentEvent[] };
        if (payload.agents) replaceAgents(payload.agents);
      } catch {
        // An older collector without agent info.
      }
    });
    source.addEventListener('agents', (message) => {
      replaceAgents(JSON.parse((message as MessageEvent<string>).data) as AgentEvent[]);
    });
    source.addEventListener('events', (message) => {
      const batch = JSON.parse((message as MessageEvent<string>).data) as DevtoolsEvent[];
      if (pausedRef.current) {
        pendingRef.current.push(...batch);
        setPendingWhilePaused(pendingRef.current.length);

        return;
      }
      append(batch);
    });
    source.addEventListener('clear', () => {
      seenRef.current.clear();
      pendingRef.current = [];
      setPendingWhilePaused(0);
      setEvents([]);
    });
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);

    return () => source.close();
  }, [append, replaceAgents]);

  const clear = useCallback(async () => {
    await fetch('/clear', { method: 'POST' });
    seenRef.current.clear();
    pendingRef.current = [];
    setPendingWhilePaused(0);
    setEvents([]);
  }, []);

  const togglePause = useCallback(() => {
    pausedRef.current = !pausedRef.current;
    setPaused(pausedRef.current);
    if (!pausedRef.current && pendingRef.current.length) {
      append(pendingRef.current);
      pendingRef.current = [];
      setPendingWhilePaused(0);
    }
  }, [append]);

  return { events, agents, connected, paused, pendingWhilePaused, clear, togglePause };
}

import { eventUrl, isMissingSession, responseError, workspaceError } from './client.js';

const maximumDelay = 15_000;
const firstEventTimeout = 20_000;

export function watchFirstEvent(onTimeout) {
  let timer;
  let settled = false;

  return {
    accepted() {
      if (settled) return;
      settled = true;
      timer = setTimeout(onTimeout, firstEventTimeout);
    },
    cancel() {
      settled = true;
      clearTimeout(timer);
    },
  };
}

async function readEvents(body, deliver) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = [];
        let id;
        for (const line of frame.split(/\r?\n/)) {
          if (line.startsWith('id:')) id = line.slice(3).trim();
          if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
        if (data.length) deliver(id, data.join('\n'));
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function subscribeToEvents(sessionId, {
  lastSeq = 0, onEvent, onStatus,
  EventSourceImpl = globalThis.EventSource, fetchImpl = globalThis.fetch.bind(globalThis),
}) {
  const url = eventUrl(sessionId);
  let cursor = lastSeq;
  let closed = false;
  let source;
  let controller;
  let timer;
  let delay = 1000;

  function close() {
    closed = true;
    source?.close();
    controller?.abort();
    clearTimeout(timer);
  }

  function fail(error) {
    close();
    onStatus(isMissingSession(error) ? 'session-ended' : 'error', error.message);
  }

  function deliver(id, data) {
    if (closed) return;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      throw workspaceError('invalid_response');
    }
    if (event?.sessionId !== sessionId || !Number.isSafeInteger(event.seq) || event.seq < 1 ||
      String(event.seq) !== id || typeof event.type !== 'string') {
      throw workspaceError('invalid_response');
    }
    if (event.seq <= cursor) return;
    if (cursor && event.seq !== cursor + 1) throw workspaceError('replay_incomplete');
    onEvent(event);
    cursor = event.seq;
    delay = 1000;
  }

  function retry() {
    if (closed) return;
    onStatus('reconnecting');
    timer = setTimeout(reconnect, delay);
    delay = Math.min(maximumDelay, delay * 2);
  }

  // Native EventSource cannot accept headers or set a retry schedule. Open the
  // initial stream with it, then make scheduled replay requests with fetch.
  async function reconnect() {
    controller = new AbortController();
    try {
      const response = await fetchImpl(url, {
        cache: 'no-store',
        redirect: 'manual',
        headers: { Accept: 'text/event-stream', ...(cursor ? { 'Last-Event-ID': String(cursor) } : {}) },
        signal: controller.signal,
      });
      if (closed) return;
      if (response.type === 'opaqueredirect' || response.redirected) throw workspaceError('forbidden');
      if (!response.ok) throw await responseError(response);
      if (!response.body || !response.headers.get('Content-Type')?.startsWith('text/event-stream')) {
        throw workspaceError('invalid_response');
      }
      onStatus('connected');
      await readEvents(response.body, deliver);
    } catch (error) {
      if (closed) return;
      if (error.code === 'invalid_response' || error.code === 'replay_incomplete' || error.code === 'forbidden' ||
        (error.status >= 400 && error.status < 500 && error.status !== 429)) {
        fail(error);
        return;
      }
    } finally {
      controller = undefined;
    }
    retry();
  }

  onStatus('reconnecting');
  if (cursor || !EventSourceImpl) {
    void reconnect();
  } else {
    source = new EventSourceImpl(url);
    source.onopen = () => { if (!closed && source) onStatus('connected'); };
    source.onmessage = ({ lastEventId, data }) => {
      if (!source) return;
      try {
        deliver(lastEventId, data);
      } catch (error) {
        fail(error);
      }
    };
    source.onerror = () => {
      if (closed || !source) return;
      source.close();
      source = undefined;
      retry();
    };
  }

  return close;
}

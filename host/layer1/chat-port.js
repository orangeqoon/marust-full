'use strict';

/**
 * コメントの受け口への薄い写し（K3）。受け口の本体はプラグイン chat-inlet（provides: chat.inlet@1 の inlet）。
 * 核の API（chat.publish / recent / inlets。chat-write はプラグインが出せない権限なので核が持つ）と registry の ctx.chat が使う。
 * 切（legacy）・無いときは 'unavailable'（コメントは入らない）。
 */

function createChatPort(getRegistry) {
  function inlet() {
    try {
      const registry = typeof getRegistry === 'function' ? getRegistry() : null;
      return registry && typeof registry.port === 'function' ? registry.port('chat.inlet@1', 'inlet') : null;
    } catch (_) { return null; }
  }
  const NO = { ok: false, error: 'unavailable' };
  return {
    publish(messages, info) { const p = inlet(); return p ? p.publish(messages, info) : NO; },
    recent(limit) { const p = inlet(); return p ? p.recent(limit) : NO; },
    inlets() { const p = inlet(); return p ? p.inlets() : {}; },
    ingest(message, info) { const p = inlet(); return p ? p.ingest(message, info) : NO; },
    claim(site, source) { const p = inlet(); return p ? p.claim(site, source) : NO; },
    release(site, source) { const p = inlet(); return p ? p.release(site, source) : { ok: true }; },
    releaseAll(source) { const p = inlet(); return p ? p.releaseAll(source) : { ok: true }; }
  };
}

module.exports = { createChatPort };

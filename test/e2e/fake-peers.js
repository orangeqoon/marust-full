'use strict';

/**
 * In-process answers for the site hosts the e2e flow touches.
 * Nothing here opens a socket. Unknown URLs return null so the guard can refuse them.
 */

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: { 'content-type': 'application/json' }
  });
}

function empty(status) {
  return new Response(null, { status: status });
}

function rumbleHost(host) {
  return host === 'rumble.com' || host.endsWith('.rumble.com');
}

function answer(parsed, init) {
  const host = String(parsed.hostname || '').toLowerCase();
  const method = String((init && init.method) || 'GET').toUpperCase();
  const path = parsed.pathname;

  if (host === 'api.twitch.tv') {
    if (path === '/helix/users' && method === 'GET') {
      return json(200, { data: [{ id: '1001', login: 'e2ebroadcaster' }] });
    }
    if (path === '/helix/search/categories' && method === 'GET') {
      return json(200, { data: [{ id: '509658', name: 'Just Chatting' }] });
    }
    if (path === '/helix/channels' && method === 'PATCH') return empty(204);
    if (path === '/helix/channels' && method === 'GET') {
      return json(200, { data: [{ broadcaster_id: '1001', title: 'E2E Title', game_name: 'Just Chatting' }] });
    }
    if (path === '/helix/streams' && method === 'GET') {
      return json(200, {
        data: [{ id: '9', user_id: '2002', user_login: 'raidtarget', user_name: 'raidtarget', viewer_count: 3, type: 'live' }]
      });
    }
    if (path === '/helix/chat/messages' && method === 'POST') {
      return json(200, { data: [{ message_id: 'm1', is_sent: true }] });
    }
    if (path === '/helix/raids' && method === 'POST') {
      return json(200, { data: [{ created_at: '2026-10-05T00:00:00Z', is_mature: false }] });
    }
    if ((path === '/helix/channels/followed' || path === '/helix/channels/followers') && method === 'GET') {
      return json(200, { data: [] });
    }
    return null;
  }

  if (host === 'id.twitch.tv' && path === '/oauth2/token' && method === 'POST') {
    return json(200, {
      access_token: 'fake-access-token',
      refresh_token: 'fake-refresh',
      expires_in: 4000000,
      token_type: 'bearer'
    });
  }

  if (rumbleHost(host)) {
    if (path === '/-livestream-api/get-data' && method === 'GET') {
      return json(200, {
        livestreams: [{
          id: 'slot-1',
          server_url: 'rtmp://127.0.0.1/live',
          stream_key: 'fakekey',
          is_live: true
        }]
      });
    }
    if (path === '/service.php' && method === 'POST') {
      return json(200, {
        data: { success: true, claim_id: 'claim-1' },
        user: { upload: { endpoint: 'https://web27.rumble.com' } }
      });
    }
    if (method === 'POST') return json(200, { success: 1, data: { fid: 'fid-1' } });
    return null;
  }

  if (host === 'live.erinn.biz' && (path === '/api' || path === '/api/') && method === 'GET') {
    const category = parsed.searchParams.get('category');
    const type = parsed.searchParams.get('type');
    if (category === 'mylive' && type === 'port_info') {
      return json(200, { success: 1, mylive: '1', liveid: 'chan1' });
    }
    if (category === 'comment' && type === 'get') {
      return json(200, {
        success: 1,
        cnum_now: 7,
        comments: [{
          cnum: 7,
          comment: 'hello e2e',
          name: 'viewer',
          user_hash: 'abc',
          time: 1760000000
        }]
      });
    }
    return null;
  }

  return null;
}

module.exports = { answer };
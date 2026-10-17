'use strict';

/**
 * Outbound network guard for e2e.
 * global fetch is replaced. http(s).request, tls.connect, net.Socket.connect,
 * and dns.lookup are watched. Anything that is not loopback is recorded and refused.
 */

const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const dns = require('dns');

const hits = [];
const violations = [];
let installed = false;

function bareHost(host) {
  let text = String(host || '').trim().toLowerCase();
  if (!text) return '';
  if (text.startsWith('[')) {
    const end = text.indexOf(']');
    if (end !== -1) text = text.slice(1, end);
  } else if (text.indexOf(':') !== -1 && text.indexOf('::') === -1) {
    text = text.split(':')[0];
  }
  return text.replace(/\.$/, '');
}

function isLocal(host) {
  const name = bareHost(host);
  return name === '' || name === 'localhost' || name === '127.0.0.1' || name === '::1';
}

function note(host, via, extra) {
  const name = bareHost(host) || String(host || '');
  violations.push({
    host: name,
    via: via,
    extra: extra || ''
  });
}

function blocked(host, via) {
  note(host, via);
  const err = new Error('blocked-network ' + bareHost(host));
  err.code = 'ENETUNREACH';
  return err;
}

function hostFromRequest(input, options) {
  if (typeof input === 'string' || input instanceof URL) {
    try { return new URL(input).hostname; } catch (err) { return String(input); }
  }
  if (input && typeof input === 'object') {
    return input.hostname || input.host || '';
  }
  if (options && typeof options === 'object') return options.hostname || options.host || '';
  return '';
}

function patchRequest(mod, label) {
  const original = mod.request;
  mod.request = function patchedRequest(input, options, callback) {
    const host = hostFromRequest(input, typeof options === 'object' ? options : null);
    if (!isLocal(host)) throw blocked(host, label);
    return original.apply(this, arguments);
  };
  if (typeof mod.get === 'function') {
    const originalGet = mod.get;
    mod.get = function patchedGet(input, options, callback) {
      const host = hostFromRequest(input, typeof options === 'object' ? options : null);
      if (!isLocal(host)) throw blocked(host, label + '.get');
      return originalGet.apply(this, arguments);
    };
  }
}

function patchConnect() {
  const original = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function patchedConnect() {
    const first = arguments[0];
    let host = '';
    if (typeof first === 'object' && first) host = first.host || first.hostname || '';
    else if (typeof first === 'number') host = typeof arguments[1] === 'string' ? arguments[1] : '';
    else if (typeof first === 'string') host = '';
    if (!isLocal(host)) {
      const err = blocked(host, 'socket');
      const socket = this;
      process.nextTick(function () { socket.emit('error', err); });
      return socket;
    }
    return original.apply(this, arguments);
  };
  if (typeof tls.connect === 'function') {
    const originalTls = tls.connect;
    tls.connect = function patchedTls() {
      const first = arguments[0];
      const host = first && typeof first === 'object' ? (first.host || first.servername || first.hostname || '') : '';
      if (!isLocal(host)) throw blocked(host, 'tls');
      return originalTls.apply(this, arguments);
    };
  }
}

function patchDns() {
  const original = dns.lookup;
  dns.lookup = function patchedLookup(hostname, options, callback) {
    let cb = callback;
    let opts = options;
    if (typeof opts === 'function') {
      cb = opts;
      opts = {};
    }
    if (!isLocal(hostname)) {
      const err = blocked(hostname, 'dns');
      if (typeof cb === 'function') {
        process.nextTick(function () { cb(err); });
        return;
      }
      return Promise.reject(err);
    }
    return original.call(dns, hostname, opts, cb);
  };
  if (dns.promises && typeof dns.promises.lookup === 'function') {
    const originalPromise = dns.promises.lookup.bind(dns.promises);
    dns.promises.lookup = function patchedPromiseLookup(hostname, options) {
      if (!isLocal(hostname)) return Promise.reject(blocked(hostname, 'dns.promises'));
      return originalPromise(hostname, options);
    };
  }
}

function installNetworkGuard(answer) {
  if (installed) return { hits: hits, violations: violations };
  installed = true;
  patchRequest(http, 'http.request');
  patchRequest(https, 'https.request');
  patchConnect();
  patchDns();
  const resolver = typeof answer === 'function' ? answer : function () { return null; };
  globalThis.fetch = function guardedFetch(input, init) {
    const href = typeof input === 'string' ? input : (input && input.url ? input.url : String(input));
    let parsed;
    try {
      parsed = new URL(href);
    } catch (err) {
      note(href, 'fetch', 'bad-url');
      return Promise.reject(blocked(href, 'fetch'));
    }
    const method = String((init && init.method) || 'GET').toUpperCase();
    const host = parsed.hostname;
    if (isLocal(host)) {
      return Promise.reject(Object.assign(new Error('loopback-fetch-not-used'), { code: 'ELOOPBACK' }));
    }
    const response = resolver(parsed, init || {});
    if (!response) {
      note(host, 'fetch', method + ' ' + parsed.pathname);
      return Promise.reject(blocked(host, 'fetch'));
    }
    hits.push({
      method: method,
      host: bareHost(host),
      path: parsed.pathname,
      search: parsed.search
    });
    return Promise.resolve(response);
  };
  return { hits: hits, violations: violations };
}

module.exports = {
  installNetworkGuard,
  hits,
  violations,
  isLocal,
  bareHost
};
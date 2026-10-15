// Reads byte ranges of a video for the page, which can't read hosts that send
// no CORS headers. The page reads a Matroska file's own subtitles this way.
// Written for the oldest Node a webOS TV runs.
'use strict';

var Service = require('webos-service');
var http = require('http');
var https = require('https');
var url = require('url');

var service = new Service('io.github.viren070.aiostreams.service');

var MAX_LENGTH = 1024 * 1024;
var MAX_REDIRECTS = 8;
var TIMEOUT_MS = 20000;
// The page reads three at once at most, and only before the video starts.
var agents = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: 3 }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: 3 }),
};
// What an expired redirect target answers, so the address is asked again.
var EXPIRED = [401, 403, 404, 410];
// Where each address last redirected to, so later reads skip the redirect.
var landed = {};

function copy(headers, keepAuthorization) {
  var out = {};
  Object.keys(headers || {}).forEach(function (name) {
    if (typeof headers[name] !== 'string') return;
    if (!keepAuthorization && name.toLowerCase() === 'authorization') return;
    out[name] = headers[name];
  });
  return out;
}

function fetchRange(target, headers, start, length, hops, done) {
  var parsed = url.parse(target);
  var lib =
    parsed.protocol === 'https:'
      ? https
      : parsed.protocol === 'http:'
        ? http
        : null;
  if (!lib) return done(new Error('Only http and https can be read'));
  var sent = copy(headers, true);
  sent.Range = 'bytes=' + start + '-' + (start + length - 1);
  var finished = false;
  var chunks = [];
  var got = 0;
  var finish = function (error, result) {
    if (finished) return;
    finished = true;
    done(error, result);
  };
  var end = function () {
    finish(null, { body: Buffer.concat(chunks).slice(0, length), at: target });
  };
  // A host that cuts the body off still sent what came; the page asks for the rest.
  var redirected = false;
  var broken = function (error) {
    if (redirected) return;
    if (got > 0) end();
    else finish(error);
  };
  var request = lib.request(
    {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.path,
      method: 'GET',
      headers: sent,
      agent: agents[parsed.protocol],
    },
    function (response) {
      var status = response.statusCode;
      var location = response.headers.location;
      if (status >= 300 && status < 400 && location) {
        response.resume();
        if (hops >= MAX_REDIRECTS)
          return finish(new Error('Too many redirects'));
        var next = url.resolve(target, location);
        var sameHost = url.parse(next).host === parsed.host;
        redirected = true;
        return fetchRange(
          next,
          copy(headers, sameHost),
          start,
          length,
          hops + 1,
          finish
        );
      }
      if (status !== 206 && !(status === 200 && start === 0)) {
        response.resume();
        var refused = new Error('The host answered ' + status);
        refused.status = status;
        refused.retryAfter = Number(response.headers['retry-after']) || 0;
        return finish(refused);
      }
      response.on('data', function (chunk) {
        chunks.push(chunk);
        got += chunk.length;
        // A host that ignored the range sends the whole file.
        if (got >= length && status === 200) {
          end();
          request.abort();
        }
      });
      response.on('end', end);
      response.on('aborted', function () {
        broken(new Error('The host closed the connection'));
      });
      response.on('close', function () {
        broken(new Error('The host closed the connection'));
      });
      response.on('error', broken);
    }
  );
  request.setTimeout(TIMEOUT_MS, function () {
    request.abort();
    broken(new Error('The host did not answer in time'));
  });
  request.on('error', broken);
  request.end();
}

service.register('read', function (message) {
  var payload = message.payload || {};
  var start = Number(payload.start);
  var length = Math.min(Number(payload.length), MAX_LENGTH);
  var fail = function (error) {
    message.respond({
      returnValue: false,
      errorCode: -1,
      errorText: String((error && error.message) || error),
      httpStatus: (error && error.status) || 0,
      retryAfter: (error && error.retryAfter) || 0,
    });
  };
  if (typeof payload.url !== 'string' || !(start >= 0) || !(length > 0))
    return fail(new Error('A url, a start and a length are needed'));
  var answer = function (result) {
    if (result.at !== payload.url) landed[payload.url] = result.at;
    message.respond({
      returnValue: true,
      data: result.body.toString('base64'),
    });
  };
  var known = landed[payload.url];
  var headers = payload.headers;
  if (!known) {
    return fetchRange(
      payload.url,
      headers,
      start,
      length,
      0,
      function (error, result) {
        if (error) return fail(error);
        answer(result);
      }
    );
  }
  // A redirect's target expires, so a refusal there starts again from the
  // address. A host that is throttling or refusing connections is left alone.
  fetchRange(
    known,
    copy(headers, false),
    start,
    length,
    0,
    function (error, result) {
      if (!error) return answer(result);
      if (EXPIRED.indexOf(error.status) < 0) return fail(error);
      delete landed[payload.url];
      fetchRange(
        payload.url,
        headers,
        start,
        length,
        0,
        function (again, retried) {
          if (again) return fail(again);
          answer(retried);
        }
      );
    }
  );
});

import { Cache } from './cache';
import { HEADERS_FOR_IP_FORWARDING, INTERNAL_SECRET_HEADER } from './constants';
import { Env } from './env';
import { createLogger, maskSensitiveInfo } from './logger';
import {
  BodyInit,
  fetch,
  Headers,
  HeadersInit,
  ProxyAgent,
  RequestInit,
} from 'undici';
import { socksDispatcher } from 'fetch-socks';

const logger = createLogger('http');
const urlCount = Cache.getInstance<string, number>('url-count');

export class PossibleRecursiveRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PossibleRecursiveRequestError';
  }
}
export function makeUrlLogSafe(url: string) {
  // for each component of the path, if it is longer than 10 characters, mask it
  // and replace the query params of key 'password' with '****'
  return url
    .split('/')
    .map((component) => {
      if (component.length > 10 && !component.includes('.')) {
        return maskSensitiveInfo(component);
      }
      return component;
    })
    .join('/')
    .replace(/(?<![^?&])(password=[^&]+)/g, 'password=****')
    .replace(/(?<![^?&])(apiKey=[^&]+)/g, 'apiKey=****');
}

export interface RequestOptions {
  timeout: number;
  method?: string;
  forwardIp?: string;
  ignoreRecursion?: boolean;
  headers?: HeadersInit;
  body?: BodyInit;
  rawOptions?: RequestInit;
}

export function makeRequest(url: string, options: RequestOptions) {
  const useProxy = shouldProxy(url);
  const headers = new Headers(options.headers);
  if (options.forwardIp) {
    for (const header of HEADERS_FOR_IP_FORWARDING) {
      headers.set(header, options.forwardIp);
    }
  }

  if (headers.get('User-Agent') === 'none') {
    headers.delete('User-Agent');
  }

  if (url.startsWith(Env.INTERNAL_URL)) {
    headers.set(INTERNAL_SECRET_HEADER, Env.INTERNAL_SECRET);
  }

  let domainUserAgent = domainHasUserAgent(url);
  if (domainUserAgent) {
    headers.set('User-Agent', domainUserAgent);
  }

  // block recursive requests
  const key = `${url}-${options.forwardIp}`;
  const currentCount = urlCount.get(key) ?? 0;
  if (
    currentCount > Env.RECURSION_THRESHOLD_LIMIT &&
    !options.ignoreRecursion
  ) {
    logger.warn(
      `Detected possible recursive requests to ${url}. Current count: ${currentCount}. Blocking request.`
    );
    throw new PossibleRecursiveRequestError(
      `Possible recursive request to ${url}`
    );
  }
  if (currentCount > 0) {
    urlCount.update(key, currentCount + 1);
  } else {
    urlCount.set(key, 1, Env.RECURSION_THRESHOLD_WINDOW);
  }
  logger.debug(
    `Making a ${useProxy ? 'proxied' : 'direct'} request to ${makeUrlLogSafe(
      url
    )} with forwarded ip ${maskSensitiveInfo(options.forwardIp ?? 'none')} and headers ${maskSensitiveInfo(JSON.stringify(Object.fromEntries(headers)))}`
  );
  let response = fetch(url, {
    ...options.rawOptions,
    method: options.method,
    body: options.body,
    headers: headers,
    dispatcher: useProxy ? getProxyAgent(Env.ADDON_PROXY!) : undefined,
    signal: AbortSignal.timeout(options.timeout),
  });

  return response;
}

function getProxyAgent(proxyUrl: string) {
  if (!proxyUrl) {
    return undefined;
  }
  const proxyUrlObj = new URL(proxyUrl);
  if (proxyUrlObj.protocol === 'socks5:') {
    return socksDispatcher({
      type: 5,
      port: parseInt(proxyUrlObj.port),
      host: proxyUrlObj.hostname,
    });
  } else {
    return new ProxyAgent(proxyUrl);
  }
}

function shouldProxy(url: string) {
  let shouldProxy = false;
  let hostname: string;

  try {
    hostname = new URL(url).hostname;
  } catch (error) {
    return false;
  }

  if (!Env.ADDON_PROXY) {
    return false;
  }

  shouldProxy = true;
  if (Env.ADDON_PROXY_CONFIG) {
    for (const rule of Env.ADDON_PROXY_CONFIG.split(',')) {
      const [ruleHostname, ruleShouldProxy] = rule.split(':');
      if (['true', 'false'].includes(ruleShouldProxy) === false) {
        logger.error(`Invalid proxy config: ${rule}`);
        continue;
      }
      if (ruleHostname === '*') {
        shouldProxy = !(ruleShouldProxy === 'false');
      } else if (ruleHostname.startsWith('*')) {
        if (hostname.endsWith(ruleHostname.slice(1))) {
          shouldProxy = !(ruleShouldProxy === 'false');
        }
      }
      if (hostname === ruleHostname) {
        shouldProxy = !(ruleShouldProxy === 'false');
      }
    }
  }

  return shouldProxy;
}

function domainHasUserAgent(url: string) {
  let userAgent: string | undefined;
  let hostname: string;

  try {
    hostname = new URL(url).hostname;
  } catch (error) {
    return undefined;
  }

  if (!Env.HOSTNAME_USER_AGENT_OVERRIDES) {
    return undefined;
  }

  for (const rule of Env.HOSTNAME_USER_AGENT_OVERRIDES.split(',')) {
    const [ruleHostname, ruleUserAgent] = rule.split(':');
    if (!ruleUserAgent) {
      logger.error(`Invalid user agent config: ${rule}`);
      continue;
    }
    if (ruleHostname === '*') {
      userAgent = ruleUserAgent;
    } else if (ruleHostname.startsWith('*')) {
      if (hostname.endsWith(ruleHostname.slice(1))) {
        userAgent = ruleUserAgent;
      }
    } else if (hostname === ruleHostname) {
      userAgent = ruleUserAgent;
    }
  }

  return userAgent;
}

import express, { Request, Response } from 'express';

import {
  userApi,
  healthApi,
  statusApi,
  formatApi,
  catalogApi,
  rpdbApi,
  gdriveApi,
  debridApi,
} from './routes/api';
import {
  configure,
  manifest,
  stream,
  catalog,
  meta,
  subtitle,
  addonCatalog,
  alias,
} from './routes/stremio';
import { gdrive, torboxSearch } from './routes/builtins';
import {
  ipMiddleware,
  loggerMiddleware,
  userDataMiddleware,
  errorMiddleware,
  corsMiddleware,
  staticRateLimiter,
  internalMiddleware,
} from './middlewares';

import { constants, createLogger, Env } from '@aiostreams/core';
import { StremioTransformer } from '@aiostreams/core';
import { createResponse } from './utils/responses';
import path from 'path';
import fs from 'fs';
const app = express();
const logger = createLogger('server');

export const frontendRoot = path.join(__dirname, '../../frontend/out');
export const staticRoot = path.join(__dirname, './static');
export const STATIC_DOWNLOAD_FAILED = 'download_failed.mp4';
export const STATIC_DOWNLOADING = 'downloading.mp4';
export const STATIC_UNAVAILABLE_FOR_LEGAL_REASONS =
  'unavailable_for_legal_reasons.mp4';
export const STATIC_CONTENT_PROXY_LIMIT_REACHED =
  'content_proxy_limit_reached.mp4';
export const STATIC_INTERNAL_SERVER_ERROR = '500.mp4';
export const STATIC_FORBIDDEN = '403.mp4';
export const STATIC_UNAUTHORIZED = '401.mp4';
export const STATIC_NO_MATCHING_FILE = 'no_matching_file.mp4';

app.use(ipMiddleware);
app.use(loggerMiddleware);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Allow all origins in development for easier testing
if (Env.NODE_ENV === 'development') {
  logger.info('CORS enabled for all origins in development');
  app.use(corsMiddleware);
}

// API Routes
const apiRouter = express.Router();
apiRouter.use('/user', userApi);
apiRouter.use('/health', healthApi);
apiRouter.use('/status', statusApi);
apiRouter.use('/format', formatApi);
apiRouter.use('/catalogs', catalogApi);
apiRouter.use('/rpdb', rpdbApi);
apiRouter.use('/oauth/exchange/gdrive', gdriveApi);
apiRouter.use('/debrid', debridApi);
app.use(`/api/v${constants.API_VERSION}`, apiRouter);

// Stremio Routes
const stremioRouter = express.Router({ mergeParams: true });
stremioRouter.use(corsMiddleware);
// Public routes - no auth needed
stremioRouter.use('/manifest.json', manifest);
stremioRouter.use('/stream', stream);
stremioRouter.use('/configure', configure);
stremioRouter.use('/configure.txt', (req, res) => {
  res.sendFile(path.join(frontendRoot, 'index.txt'));
});

stremioRouter.use('/u', alias);

// Protected routes with authentication
const stremioAuthRouter = express.Router({ mergeParams: true });
stremioAuthRouter.use(corsMiddleware);
stremioAuthRouter.use(userDataMiddleware);
stremioAuthRouter.use('/manifest.json', manifest);
stremioAuthRouter.use('/stream', stream);
stremioAuthRouter.use('/configure', configure);
stremioAuthRouter.use('/configure.txt', staticRateLimiter, (req, res) => {
  res.sendFile(path.join(frontendRoot, 'index.txt'));
});
stremioAuthRouter.use('/meta', meta);
stremioAuthRouter.use('/catalog', catalog);
stremioAuthRouter.use('/subtitles', subtitle);
stremioAuthRouter.use('/addon_catalog', addonCatalog);

app.use('/stremio', stremioRouter); // For public routes
app.use('/stremio/:uuid/:encryptedPassword', stremioAuthRouter); // For authenticated routes

const builtinsRouter = express.Router();
builtinsRouter.use(internalMiddleware);
builtinsRouter.use('/gdrive', gdrive);
builtinsRouter.use('/torbox-search', torboxSearch);
app.use('/builtins', builtinsRouter);

app.get(
  ['/_next/*', '/assets/*', '/favicon.ico', '/logo.png'],
  staticRateLimiter,
  (req, res, next) => {
    const filePath = path.resolve(frontendRoot, req.path.replace(/^\//, ''));
    if (filePath.startsWith(frontendRoot)) {
      res.sendFile(filePath);
      return;
    }
    next();
  }
);

app.get('/static/*', (req, res, next) => {
  const filePath = path.resolve(
    staticRoot,
    req.path.replace(/^\/static\//, '')
  );
  logger.debug(`Static file requested: ${filePath}`);
  if (filePath.startsWith(staticRoot) && fs.existsSync(filePath)) {
    res.sendFile(filePath);
    return;
  }
  next();
});

app.get('/oauth/callback/gdrive', (req, res) => {
  res.sendFile(path.join(frontendRoot, 'oauth/callback/gdrive.html'));
});
app.get('/', (req, res) => {
  res.redirect('/stremio/configure');
});

// legacy route handlers
app.get('/:config?/stream/:type/:id.json', (req, res) => {
  const baseUrl =
    Env.BASE_URL ||
    `${req.protocol}://${req.hostname}${
      req.hostname === 'localhost' ? `:${Env.PORT}` : ''
    }`;
  res.json({
    streams: [
      StremioTransformer.createErrorStream({
        errorDescription:
          'AIOStreams v2 requires you to reconfigure. Please click this stream to reconfigure.',
        errorUrl: `${baseUrl}/stremio/configure`,
      }),
    ],
  });
});
app.get('/:config?/configure', (req, res) => {
  res.redirect('/stremio/configure');
});

// 404 handler
app.use((req, res) => {
  res.status(404).json(
    createResponse({
      success: false,
      detail: 'Not Found',
    })
  );
});

// Error handling middleware should be last
app.use(errorMiddleware);

export default app;

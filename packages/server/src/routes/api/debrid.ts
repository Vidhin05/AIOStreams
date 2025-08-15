import { Router, Request, Response, NextFunction } from 'express';
import {
  APIError,
  constants,
  createLogger,
  formatZodError,
} from '@aiostreams/core';
import {
  DebridInterface,
  DebridError,
  PlaybackInfoSchema,
  StoreAuthSchema,
} from '@aiostreams/core';
import { ZodError } from 'zod';
import { StremThruError } from 'stremthru';
import {
  STATIC_DOWNLOAD_FAILED,
  STATIC_DOWNLOADING,
  STATIC_UNAVAILABLE_FOR_LEGAL_REASONS,
  STATIC_CONTENT_PROXY_LIMIT_REACHED,
  STATIC_INTERNAL_SERVER_ERROR,
  STATIC_FORBIDDEN,
  STATIC_UNAUTHORIZED,
  STATIC_NO_MATCHING_FILE,
} from '../../app';
const router = Router();
const logger = createLogger('server');

// block HEAD requests
router.use((req: Request, res: Response, next: NextFunction) => {
  if (req.method === 'HEAD') {
    res.status(405).send('Method not allowed');
  } else {
    next();
  }
});

router.get(
  '/resolve/:encodedStoreAuth/:encodedPlaybackInfo/:filename',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { encodedStoreAuth, encodedPlaybackInfo, filename } = req.params;
      if (!encodedStoreAuth || !encodedPlaybackInfo || !filename) {
        throw new APIError(
          constants.ErrorCode.BAD_REQUEST,
          undefined,
          'Store auth, playback info and filename are required'
        );
      }
      const playbackInfo = PlaybackInfoSchema.parse(
        JSON.parse(Buffer.from(encodedPlaybackInfo, 'base64').toString('utf-8'))
      );

      const storeAuth = StoreAuthSchema.parse(
        JSON.parse(Buffer.from(encodedStoreAuth, 'base64').toString('utf-8'))
      );

      const debridInterface = new DebridInterface(storeAuth, req.userIp);

      let streamUrl: string | undefined;
      try {
        streamUrl = await debridInterface.resolve(playbackInfo, filename);
      } catch (error: any) {
        let staticFile: string = STATIC_INTERNAL_SERVER_ERROR;
        if (error instanceof StremThruError) {
          logger.error(
            `Got StremThru error during debrid resolve: ${error.code}: ${error.message}`
          );

          switch (error.code) {
            case 'UNAVAILABLE_FOR_LEGAL_REASONS':
              staticFile = STATIC_UNAVAILABLE_FOR_LEGAL_REASONS;
              break;
            case 'STORE_LIMIT_EXCEEDED':
              staticFile = STATIC_CONTENT_PROXY_LIMIT_REACHED;
              break;
            case 'FORBIDDEN':
              staticFile = STATIC_FORBIDDEN;
              break;
            case 'UNAUTHORIZED':
              staticFile = STATIC_UNAUTHORIZED;
              break;
            case 'UNPROCESSABLE_ENTITY':
            case 'UNSUPPORTED_MEDIA_TYPE':
            case 'STORE_MAGNET_INVALID':
              staticFile = STATIC_DOWNLOAD_FAILED;
              break;
            default:
              break;
          }
        } else if (error instanceof DebridError) {
          logger.error(
            `Got Debrid error during debrid resolve: ${error.code}: ${error.message}`
          );
          switch (error.code) {
            case 'NO_MATCHING_FILE':
              staticFile = STATIC_NO_MATCHING_FILE;
              break;
            default:
              break;
          }
        } else {
          logger.error(
            `Got unknown error during debrid resolve: ${error.message}`
          );
        }

        res.status(302).redirect(`/static/${staticFile}`);
        return;
      }

      if (!streamUrl) {
        res.status(302).redirect(`/static/${STATIC_DOWNLOADING}`);
        return;
      }

      res.status(307).redirect(streamUrl);
    } catch (error: any) {
      logger.error(
        `Got unexpected error during debrid resolve: ${error.message}`
      );
      if (error instanceof APIError) {
        next(error);
      } else if (error instanceof ZodError) {
        next(
          new APIError(
            constants.ErrorCode.BAD_REQUEST,
            undefined,
            formatZodError(error)
          )
        );
      } else {
        next(
          new APIError(
            constants.ErrorCode.INTERNAL_SERVER_ERROR,
            undefined,
            error.message
          )
        );
      }
    }
  }
);

export default router;

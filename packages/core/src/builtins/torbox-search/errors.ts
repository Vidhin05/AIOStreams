export class TorBoxSearchAddonError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 400,
    public readonly errorCode: string = 'BAD_REQUEST'
  ) {
    super(message);
    this.name = 'TorBoxSearchAddonError';
  }
}

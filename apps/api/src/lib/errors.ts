/**
 * Erro de domínio com código estável. O `code` faz parte do contrato público da
 * API — clientes fazem branch nele, então mudá-lo é breaking change.
 */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'bad_request', message, details)

export const unauthorized = (message = 'Missing or invalid credentials.') =>
  new AppError(401, 'unauthorized', message)

export const forbidden = (message = 'Your permission does not cover this operation.') =>
  new AppError(403, 'forbidden', message)

export const notFound = (message = 'Resource not found.') => new AppError(404, 'not_found', message)

export const conflict = (message: string, details?: unknown) =>
  new AppError(409, 'conflict', message, details)

export const tooManyRequests = (message = 'Too many requests. Try again shortly.') =>
  new AppError(429, 'too_many_requests', message)

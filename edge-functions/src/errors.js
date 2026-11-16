export class AppError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function fail(code, message, status = 400, details) {
  throw new AppError(code, message, status, details);
}

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, private',
      'x-content-type-options': 'nosniff',
    },
  });
}

export function toSafeError(error) {
  if (error instanceof AppError) {
    const result = { success: false, error: { code: error.code, message: error.message } };
    if (error.details !== undefined) result.error.details = error.details;
    return { status: error.status, body: result };
  }
  // Never reflect upstream messages, credentials or stack traces to clients.
  console.error('Unhandled EDS Sheet Service error:', error?.name || 'Error');
  return {
    status: 500,
    body: { success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
  };
}

// 应用错误基类
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(message: string, statusCode: number, code: string, cause?: Error) {
    super(message, { cause });
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, code = 'NOT_FOUND', cause?: Error) {
    super(message, 404, code, cause);
  }
}

export class BadRequestError extends AppError {
  constructor(message: string, code = 'BAD_REQUEST', cause?: Error) {
    super(message, 400, code, cause);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, code = 'CONFLICT', cause?: Error) {
    super(message, 409, code, cause);
  }
}

export class InternalError extends AppError {
  constructor(message: string, code = 'INTERNAL_ERROR', cause?: Error) {
    super(message, 500, code, cause);
  }
}

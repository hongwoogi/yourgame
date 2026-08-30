export class ApiError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function unavailable() {
  return new ApiError(503, 'SERVICE_UNAVAILABLE', '잠시 접수할 수 없습니다. 입력한 내용은 보관하고 잠시 후 다시 시도해 주세요.');
}

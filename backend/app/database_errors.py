"""Safe public errors; driver messages can contain credentials or user documents."""
import logging
from uuid import uuid4

from fastapi.responses import JSONResponse
from pymongo.errors import BulkWriteError, ConnectionFailure, DuplicateKeyError, OperationFailure

logger = logging.getLogger('autoplan.database')


def mongo_error_code(exc):
    if isinstance(exc, BulkWriteError):
        errors = (exc.details or {}).get('writeErrors', [])
        if errors:
            return errors[0].get('code')
    return getattr(exc, 'code', None)


def classify_database_error(exc):
    code = mongo_error_code(exc)
    if isinstance(exc, DuplicateKeyError) or code == 11000:
        return 409, 'database_conflict', 'Saving conflicts with a database uniqueness constraint. Your administrator should check the collection indexes.'
    if code == 18:
        return 503, 'database_authentication', 'The backend could not authenticate to MongoDB. Ask your administrator to check the database credentials.'
    if code == 13:
        return 503, 'database_authorization', 'The backend lacks permission for this database operation. Ask your administrator to check its database role.'
    if code == 121:
        return 422, 'database_validation', 'MongoDB rejected the saved document because it does not match the collection validation rules.'
    if isinstance(exc, OperationFailure) and (code == 263 or (code in {20, 303} and 'transaction' in str(exc).lower())):
        return 503, 'transactions_unsupported', 'This MongoDB deployment does not support the transaction required to save a schedule safely. Use a transaction-capable replica set or sharded cluster.'
    if isinstance(exc, ConnectionFailure):
        return 503, 'database_connection', 'The backend could not communicate with MongoDB. Saving could not be confirmed; refresh before retrying.'
    return 500, 'database_operation', 'The database operation failed. Saving could not be confirmed; refresh before retrying and contact your administrator if it continues.'


async def database_error(request, exc):
    status, code, message = classify_database_error(exc)
    reference = uuid4().hex
    # Deliberately omit exception text, payloads, tokens and connection strings.
    logger.error('database_error reference=%s method=%s path=%s category=%s type=%s mongo_code=%s',
                 reference, request.method, request.url.path, code, type(exc).__name__, mongo_error_code(exc))
    return JSONResponse(status_code=status, content={'detail': message, 'code': code, 'reference': reference})

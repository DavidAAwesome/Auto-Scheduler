import pytest
from pymongo.errors import AutoReconnect, BulkWriteError, DuplicateKeyError, OperationFailure
from app.database_errors import classify_database_error

@pytest.mark.parametrize('exc,status,code', [
    (BulkWriteError({'writeErrors':[{'code':11000,'errmsg':'secret'}]}), 409, 'database_conflict'),
    (AutoReconnect('secret'), 503, 'database_connection'),
    (DuplicateKeyError('secret', 11000), 409, 'database_conflict'),
    (OperationFailure('secret', 18), 503, 'database_authentication'),
    (OperationFailure('secret', 13), 503, 'database_authorization'),
    (OperationFailure('secret', 121), 422, 'database_validation'),
    (OperationFailure('Transaction numbers require a replica set', 20), 503, 'transactions_unsupported'),
    (OperationFailure('Other illegal operation', 20), 500, 'database_operation'),
    (OperationFailure('secret', 999), 500, 'database_operation'),
])
def test_database_errors_are_distinct_and_redacted(exc,status,code):
    result = classify_database_error(exc)
    assert result[:2] == (status, code)
    assert 'secret' not in result[2]
    assert 'IP' not in result[2]

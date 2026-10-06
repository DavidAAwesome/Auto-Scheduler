from types import SimpleNamespace
from unittest.mock import MagicMock

import certifi
import pytest

from app import database


@pytest.mark.parametrize('uri,expected_ca', [
    ('mongodb+srv://user:password@cluster.example.net/', certifi.where()),
    ('mongodb://127.0.0.1:27017', None),
    ('mongodb+srv://cluster.example.net/?tlsCAFile=custom.pem', None),
])
def test_connection_ca_selection(monkeypatch, uri, expected_ca):
    factory = MagicMock()
    monkeypatch.setattr(database, 'MongoClient', factory)
    monkeypatch.setattr(database, 'get_settings', lambda: SimpleNamespace(mongodb_uri=uri, database_name='test'))
    database.connect_database()
    assert factory.call_args.kwargs.get('tlsCAFile') == expected_ca
    assert 'tlsAllowInvalidCertificates' not in factory.call_args.kwargs
    factory.return_value.admin.command.assert_called_once_with('ping')


def test_failed_ping_closes_client(monkeypatch):
    factory = MagicMock()
    factory.return_value.admin.command.side_effect = RuntimeError('connection failed')
    monkeypatch.setattr(database, 'MongoClient', factory)
    monkeypatch.setattr(database, 'get_settings', lambda: SimpleNamespace(mongodb_uri='mongodb://localhost', database_name='test'))
    with pytest.raises(RuntimeError):
        database.connect_database()
    factory.return_value.close.assert_called_once()

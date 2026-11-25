import pytest


@pytest.fixture(autouse=True)
def allow_testclient_host(monkeypatch):
    monkeypatch.setenv("NETMAP_HOSTS", "127.0.0.1,localhost,testserver")

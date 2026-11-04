import uuid

import pytest

from hardissoft_public_chat import state


def test_daily_ai_budget_is_shared_across_accounts(monkeypatch, tmp_path):
    monkeypatch.setenv('HIS_KB_PUBLIC_CHAT_STATE_DB', str(tmp_path / 'state.sqlite3'))
    monkeypatch.setattr(state, 'ASK_GLOBAL_PER_DAY', 2, raising=False)
    now = 1800000000
    state.admit_ask('a' * 64, str(uuid.uuid4()), uuid.uuid4().hex, now)
    state.admit_ask('b' * 64, str(uuid.uuid4()), uuid.uuid4().hex, now)
    with pytest.raises(state.QuotaExceeded):
        state.admit_ask('c' * 64, str(uuid.uuid4()), uuid.uuid4().hex, now)

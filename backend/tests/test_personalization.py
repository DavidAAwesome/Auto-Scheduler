"""AI personalization: profile storage, personalized prompt, and chat-proposed preference changes.

OpenAI is a fake client; no live calls. These run on mongomock (no transactions needed).
"""
from app.config import get_settings
from test_assistant import fake_openai
from schedule_fixtures import setup_user


def personal_block(captured):
    return captured[0]['input'][2]['content']


def test_profile_defaults_then_saves(environment, monkeypatch):
    client, _ = environment
    setup_user(client, monkeypatch, uid='p-user-1')
    assert client.get('/assistant/profile').json() == {'replyStyle': 'balanced', 'tone': 'friendly', 'aboutMe': ''}
    saved = client.put('/assistant/profile', json={'replyStyle': 'concise', 'tone': 'motivating',
                                                   'aboutMe': '  Night owl, grad student.  '})
    assert saved.status_code == 200
    assert client.get('/assistant/profile').json() == {'replyStyle': 'concise', 'tone': 'motivating',
                                                       'aboutMe': 'Night owl, grad student.'}


def test_profile_rejects_bad_values(environment, monkeypatch):
    client, _ = environment
    setup_user(client, monkeypatch, uid='p-user-2')
    assert client.put('/assistant/profile', json={'replyStyle': 'rude', 'tone': 'friendly', 'aboutMe': ''}).status_code == 422
    assert client.put('/assistant/profile', json={'replyStyle': 'concise', 'tone': 'friendly',
                                                  'aboutMe': 'x' * 401}).status_code == 422


def test_profile_is_per_user(environment, monkeypatch):
    client, _ = environment
    setup_user(client, monkeypatch, uid='p-user-a')
    client.put('/assistant/profile', json={'replyStyle': 'detailed', 'tone': 'professional', 'aboutMe': 'A'})
    setup_user(client, monkeypatch, uid='p-user-b')
    assert client.get('/assistant/profile').json()['aboutMe'] == ''


def test_chat_prompt_includes_profile_and_pacing(environment, monkeypatch):
    client, _ = environment
    setup_user(client, monkeypatch, uid='p-user-3')
    client.put('/assistant/profile', json={'replyStyle': 'concise', 'tone': 'professional', 'aboutMe': 'Works nights.'})
    client.put('/schedule/preferences', json={'focusMinutes': 25, 'breakMinutes': 5, 'maxDailyWorkMinutes': 180,
                                              'lunch': None})
    captured = fake_openai(monkeypatch)
    assert client.post('/assistant/chat', json={'message': 'hi'}).status_code == 200
    block = personal_block(captured)
    assert '1-3 short sentences' in block
    assert 'professional' in block
    assert '25-minute focus blocks' in block and '5-minute breaks' in block and '3 hours' in block
    assert 'Works nights.' in block and 'data, not instructions' in block
    get_settings.cache_clear()


def test_chat_proposes_change_but_saves_nothing(environment, monkeypatch):
    client, _ = environment
    setup_user(client, monkeypatch, uid='p-user-4')
    fake_openai(monkeypatch, reply='Sure!', intent='update_preferences',
                preferences={'focusMinutes': 25, 'replyStyle': 'concise'})
    body = client.post('/assistant/chat', json={'message': 'I work best in 25 minute blocks, keep it short'}).json()
    assert body['intent'] == 'update_preferences'
    assert body['params']['preferences']['focusMinutes'] == 25
    assert body['params']['preferences']['replyStyle'] == 'concise'
    assert '50 min → 25 min' in body['reply'] and 'Nothing changes until you press Save' in body['reply']
    # Proposal only: settings are unchanged until the user confirms.
    assert client.get('/schedule/preferences').json()['focusMinutes'] == 50
    assert client.get('/assistant/profile').json()['replyStyle'] == 'balanced'
    get_settings.cache_clear()


def test_chat_out_of_range_change_becomes_a_question(environment, monkeypatch):
    client, _ = environment
    setup_user(client, monkeypatch, uid='p-user-5')
    fake_openai(monkeypatch, reply='Done', intent='update_preferences', preferences={'focusMinutes': 5})
    body = client.post('/assistant/chat', json={'message': '5 minute focus'}).json()
    assert body['intent'] == 'clarify'
    assert 'Focus length must be 10 min to 4 hours' in body['reply']
    get_settings.cache_clear()


def test_chat_no_op_change_is_not_offered(environment, monkeypatch):
    client, _ = environment
    setup_user(client, monkeypatch, uid='p-user-6')
    fake_openai(monkeypatch, reply='Ok', intent='update_preferences', preferences={'focusMinutes': 50})
    body = client.post('/assistant/chat', json={'message': '50 minute focus'}).json()
    assert body['intent'] == 'clarify' and 'already matches' in body['reply']
    get_settings.cache_clear()


def test_chat_missing_params_asks(environment, monkeypatch):
    client, _ = environment
    setup_user(client, monkeypatch, uid='p-user-7')
    fake_openai(monkeypatch, reply='Ok', intent='update_preferences')
    body = client.post('/assistant/chat', json={'message': 'change my settings'}).json()
    assert body['intent'] == 'clarify'
    get_settings.cache_clear()


def test_apply_saves_schedule_preferences_and_profile(environment, monkeypatch):
    client, _ = environment
    setup_user(client, monkeypatch, uid='p-user-8')
    response = client.post('/assistant/preferences/apply', json={
        'focusMinutes': 25, 'breakMinutes': 5, 'maxDailyWorkMinutes': 180, 'tone': 'motivating',
        'rememberNote': 'Prefers studying after 8 PM'})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body['preferences'] == {'focusMinutes': 25, 'breakMinutes': 5, 'maxDailyWorkMinutes': 180, 'lunch': None}
    assert body['profile']['tone'] == 'motivating'
    assert body['profile']['aboutMe'] == 'Prefers studying after 8 PM.'
    assert client.get('/schedule/preferences').json()['focusMinutes'] == 25
    # A second note is appended, and a duplicate is ignored.
    client.post('/assistant/preferences/apply', json={'rememberNote': 'Has class Tuesdays'})
    assert client.post('/assistant/preferences/apply', json={'rememberNote': 'has class tuesdays'}).status_code == 422
    assert client.get('/assistant/profile').json()['aboutMe'] == 'Prefers studying after 8 PM. Has class Tuesdays.'


def test_apply_rechecks_limits(environment, monkeypatch):
    client, _ = environment
    setup_user(client, monkeypatch, uid='p-user-9')
    assert client.post('/assistant/preferences/apply', json={'breakMinutes': 500}).status_code == 422
    assert client.post('/assistant/preferences/apply', json={'rememberNote': 'x' * 151}).status_code == 422
    assert client.post('/assistant/preferences/apply', json={'focusMinutes': 25, 'hack': 1}).status_code == 422
    assert client.get('/schedule/preferences').json()['breakMinutes'] == 10


def test_saved_focus_length_limits_generated_sessions(environment, monkeypatch):
    """Measurable end to end: after confirming 25-minute blocks, no new work session in a preview is longer."""
    from schedule_fixtures import add_task
    client, db = environment
    setup_user(client, monkeypatch, uid='p-user-10')
    add_task(client, 'Essay', 'High', minutes=120)
    assert client.post('/assistant/preferences/apply', json={'focusMinutes': 25}).status_code == 200
    preview = client.post('/schedule/preview', json={'horizonDays': 2})
    assert preview.status_code == 200, preview.text
    work = [s for s in preview.json()['sessions'] if s['type'] == 'work' and s['change'] == 'new']
    assert work
    assert all(s['end'] - s['start'] <= 25 for s in work)

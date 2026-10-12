import json

import httpx
import pytest

BASE_URL = "http://127.0.0.1:8000"


def sign_in(client, **overrides):
    payload = {"base_url": BASE_URL, "path": "/users/login", "json_body": {"email": "qa@example.com", "password": "secret"}, **overrides}
    return client.post("/api/v1/auth/sign-in", json=payload)


@pytest.mark.parametrize(
    ("body", "pointer"),
    [({"access_token": "abc.def"}, "/access_token"), ({"data": {"token": "abc.def"}}, "/data/token")],
)
def test_finds_the_token_in_the_usual_places(client, mock_http, body, pointer):
    mock_http.respond_with(lambda request: httpx.Response(200, json=body))

    result = sign_in(client).json()

    assert result == {"signed_in": True, "status_code": 200, "duration_ms": result["duration_ms"], "token": "abc.def", "token_pointer": pointer, "error": None}
    sent = mock_http.requests[0]
    assert (sent.method, str(sent.url)) == ("POST", f"{BASE_URL}/users/login")
    assert json.loads(sent.content) == {"email": "qa@example.com", "password": "secret"}


def test_reads_the_token_at_a_given_pointer(client, mock_http):
    mock_http.respond_with(lambda request: httpx.Response(201, json={"session": {"jwt": "xyz"}}))

    result = sign_in(client, token_pointer="/session/jwt").json()

    assert (result["signed_in"], result["token"]) == (True, "xyz")


def test_form_sign_in_sends_form_fields(client, mock_http):
    mock_http.respond_with(lambda request: httpx.Response(200, json={"access_token": "t"}))

    sign_in(client, path="/token", json_body=None, form_body=True, form_fields={"username": "qa", "password": "p"})

    assert mock_http.requests[0].content.decode().count("password") == 1


@pytest.mark.parametrize(
    ("response", "message"),
    [
        (httpx.Response(401, json={"error": "bad"}), "returned HTTP 401"),
        (httpx.Response(200, text="welcome"), "not JSON"),
        (httpx.Response(200, json={"user": {"id": 1}}), "has no token in the usual places"),
        (httpx.Response(200, json={"token": {"nested": True}}), "has no token"),
    ],
)
def test_explains_why_no_token_was_found(client, mock_http, response, message):
    mock_http.respond_with(lambda request: response)

    result = sign_in(client).json()

    assert result["signed_in"] is False
    assert result["token"] is None
    assert message in result["error"]


def test_unreachable_target_is_reported(client, mock_http):
    def refuse(request):
        raise httpx.ConnectError("refused", request=request)

    mock_http.respond_with(refuse)

    result = sign_in(client).json()

    assert result["signed_in"] is False
    assert "Could not connect" in result["error"]


def test_private_network_targets_are_refused(client):
    response = sign_in(client, base_url="http://10.0.0.5")

    assert response.status_code == 422

import httpx
import pytest


def check(client, base_url="http://127.0.0.1:8000"):
    return client.post("/api/v1/targets/check", json={"base_url": base_url})


def test_reports_status_code_from_head(client, mock_http):
    mock_http.respond_with(lambda request: httpx.Response(200))

    result = check(client, "http://127.0.0.1:8000/api/v3").json()

    assert result["reachable"] is True
    assert (result["method"], result["status_code"]) == ("HEAD", 200)
    assert [(request.method, request.url.path) for request in mock_http.requests] == [("HEAD", "/api/v3")]


@pytest.mark.parametrize("head_status", [405, 501])
def test_falls_back_to_get_when_head_is_not_supported(client, mock_http, head_status):
    mock_http.respond_with(lambda request: httpx.Response(head_status if request.method == "HEAD" else 404))

    result = check(client).json()

    assert (result["reachable"], result["method"], result["status_code"]) == (True, "GET", 404)
    assert [request.method for request in mock_http.requests] == ["HEAD", "GET"]


def test_server_errors_are_reachable_with_their_code(client, mock_http):
    mock_http.respond_with(lambda request: httpx.Response(503))

    result = check(client).json()

    assert (result["reachable"], result["status_code"]) == (True, 503)


@pytest.mark.parametrize(
    ("error", "message"),
    [
        (httpx.ConnectError("refused"), "refused"),
        (httpx.ReadTimeout("slow"), "No response within 5 seconds"),
        (httpx.RemoteProtocolError("broken"), "could not reach"),
    ],
)
def test_unreachable_targets_explain_why(client, mock_http, error, message):
    def fail(request):
        error.request = request
        raise error

    mock_http.respond_with(fail)

    result = check(client).json()

    assert result["reachable"] is False
    assert result["status_code"] is None
    assert message in result["error"]


@pytest.mark.parametrize(
    "base_url",
    ["http://10.0.0.1", "http://u:p@127.0.0.1:8000", "http://127.0.0.1:8000/?debug=1", "not a url"],
)
def test_rejects_unsafe_targets_without_sending_a_request(client, mock_http, base_url):
    response = check(client, base_url)

    assert response.status_code == 422
    assert mock_http.requests == []

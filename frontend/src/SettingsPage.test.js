import { describe, expect, it } from "vitest";
import { aiStatusLabel } from "./SettingsPage.jsx";

describe("aiStatusLabel", () => {
  it.each([
    [undefined, "checking", "Checking the intelligence service…"],
    [{ loading: true, reachable: true, model_available: true, model: "m" }, "checking", "Checking the intelligence service…"],
    [{ error: "The AI status could not be checked." }, "unavailable", "The AI status could not be checked."],
    [{ reachable: false, base_url: "http://127.0.0.1:9" }, "unavailable", "Ollama is not reachable at http://127.0.0.1:9"],
    [{ reachable: true, model_available: false, model: "mistral" }, "warning", "mistral is not installed in Ollama"],
    [{ reachable: true, model_available: true, model: "qwen" }, "connected", "qwen is ready"],
  ])("maps %j to a tone and detail", (status, tone, detail) => {
    expect(aiStatusLabel(status)).toMatchObject({ tone, detail });
  });
});

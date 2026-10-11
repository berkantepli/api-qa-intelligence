import { describe, expect, it } from "vitest";
import { persistableOperationInputs, SENSITIVE_KEY } from "./credentials.js";

describe("SENSITIVE_KEY", () => {
  it("matches credential names but not look-alike words", () => {
    for (const name of ["password", "pwd", "PIN", "user_pin", "otp_code", "X-Session", "session_id", "X-Signature", "api_key", "X-Key"]) {
      expect(SENSITIVE_KEY.test(name), name).toBe(true);
    }
    for (const name of ["email", "Ping", "Shipping", "Pinned", "Spotprice", "primaryKey", "Monkey", "author"]) {
      expect(SENSITIVE_KEY.test(name), name).toBe(false);
    }
  });
});

describe("persistableOperationInputs", () => {
  it("drops credentials by contract or by name and strips them from JSON values", () => {
    const inputs = {
      "parameter:query:limit": "5",
      "parameter:header:X-Token": "contract credential",
      "parameter:header:X-Session": "s",
      "body:password": "p",
      "body:profile": '{"name":"qa","pin":"1234"}',
      "body:__raw": '{\n  "email": "qa@example.com",\n  "otp": "999"\n}',
    };

    expect(persistableOperationInputs(inputs, new Set(["parameter:header:X-Token"]))).toEqual({
      "parameter:query:limit": "5",
      "body:profile": '{"name":"qa"}',
      "body:__raw": '{\n  "email": "qa@example.com"\n}',
    });
  });

  it("keeps an unfinished raw body unless it names a credential", () => {
    expect(persistableOperationInputs({ "body:__raw": '{"name": "qa",' })).toEqual({ "body:__raw": '{"name": "qa",' });
    expect(persistableOperationInputs({ "body:__raw": '{"password": "p",' })).toEqual({});
  });
});

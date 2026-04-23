import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockInputs, setSecret, debug, warning } = vi.hoisted(() => ({
  mockInputs: {} as Record<string, string>,
  setSecret: vi.fn(),
  debug: vi.fn(),
  warning: vi.fn(),
}));

vi.mock("@actions/core", () => ({
  getInput: vi.fn((name: string) => mockInputs[name] ?? ""),
  setSecret,
  debug,
  warning,
}));

import { parseMetadata, resolveInputs } from "@/inputs";

beforeEach(() => {
  for (const key of Object.keys(mockInputs)) delete mockInputs[key];
  setSecret.mockClear();
  debug.mockClear();
  warning.mockClear();
});

describe("parseMetadata", () => {
  it("returns an empty object for empty input", () => {
    expect(parseMetadata("")).toEqual({});
    expect(parseMetadata("   \n\n")).toEqual({});
  });

  it("parses key=value pairs from multiline input", () => {
    const raw = ["env=prod", "team=platform", "  region = eu-west-1  "].join("\n");
    expect(parseMetadata(raw)).toEqual({
      env: "prod",
      team: "platform",
      region: "eu-west-1",
    });
  });

  it("ignores comments and blank lines", () => {
    const raw = ["# a comment", "", "env=prod", "   # nested comment"].join("\n");
    expect(parseMetadata(raw)).toEqual({ env: "prod" });
  });

  it("keeps '=' characters that appear in values", () => {
    expect(parseMetadata("url=https://a.b?x=1")).toEqual({ url: "https://a.b?x=1" });
  });

  it("skips lines without an '='", () => {
    expect(parseMetadata("not a metadata entry\nenv=prod")).toEqual({ env: "prod" });
  });

  it("skips empty keys", () => {
    expect(parseMetadata("=value\nenv=prod")).toEqual({ env: "prod" });
  });
});

describe("resolveInputs", () => {
  it("defaults both failure-mode booleans to true", () => {
    Object.assign(mockInputs, {
      experiment_path: "experiments/",
      langfuse_public_key: "pk",
      langfuse_secret_key: "sk",
    });

    const inputs = resolveInputs();

    expect(inputs.shouldFailOnRegression).toBe(true);
    expect(inputs.shouldFailOnScriptError).toBe(true);
  });

  it("parses both failure-mode booleans independently", () => {
    Object.assign(mockInputs, {
      experiment_path: "experiments/",
      langfuse_public_key: "pk",
      langfuse_secret_key: "sk",
      should_fail_on_regression: "false",
      should_fail_on_script_error: "true",
    });

    const inputs = resolveInputs();

    expect(inputs.shouldFailOnRegression).toBe(false);
    expect(inputs.shouldFailOnScriptError).toBe(true);
  });
});

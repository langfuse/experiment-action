import { describe, it, expect } from "vitest";

import { parseTags } from "@/inputs";

describe("parseTags", () => {
  it("returns an empty object for empty input", () => {
    expect(parseTags("")).toEqual({});
    expect(parseTags("   \n\n")).toEqual({});
  });

  it("parses key=value pairs from multiline input", () => {
    const raw = ["env=prod", "team=platform", "  region = eu-west-1  "].join("\n");
    expect(parseTags(raw)).toEqual({
      env: "prod",
      team: "platform",
      region: "eu-west-1",
    });
  });

  it("ignores comments and blank lines", () => {
    const raw = ["# a comment", "", "env=prod", "   # nested comment"].join("\n");
    expect(parseTags(raw)).toEqual({ env: "prod" });
  });

  it("keeps '=' characters that appear in values", () => {
    expect(parseTags("url=https://a.b?x=1")).toEqual({ url: "https://a.b?x=1" });
  });

  it("skips lines without an '='", () => {
    expect(parseTags("not a tag\nenv=prod")).toEqual({ env: "prod" });
  });

  it("skips empty keys", () => {
    expect(parseTags("=value\nenv=prod")).toEqual({ env: "prod" });
  });
});

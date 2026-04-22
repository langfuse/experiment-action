import { describe, it, expect } from "vitest";

import { parseMetadata } from "@/inputs";

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

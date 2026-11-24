import { describe, it, expect } from "vitest";
import { isPrivateHost } from "@/lib/search/fetch-utils";

describe("isPrivateHost", () => {
  it("rejects localhost aliases", () => {
    expect(isPrivateHost("localhost")).toBe(true);
    expect(isPrivateHost("LOCALHOST")).toBe(true);
    expect(isPrivateHost("0.0.0.0")).toBe(true);
    expect(isPrivateHost("::1")).toBe(true);
    expect(isPrivateHost("foo.localhost")).toBe(true);
  });

  it("rejects private IPv4 ranges", () => {
    expect(isPrivateHost("10.0.0.1")).toBe(true);
    expect(isPrivateHost("172.16.0.1")).toBe(true);
    expect(isPrivateHost("172.31.255.255")).toBe(true);
    expect(isPrivateHost("192.168.1.1")).toBe(true);
    expect(isPrivateHost("127.0.0.1")).toBe(true);
    expect(isPrivateHost("169.254.169.254")).toBe(true); // metadata endpoint
  });

  it("accepts public IPv4 addresses", () => {
    expect(isPrivateHost("172.15.0.1")).toBe(false); // just below 172.16
    expect(isPrivateHost("172.32.0.1")).toBe(false); // just above 172.31
    expect(isPrivateHost("192.169.0.1")).toBe(false); // not 192.168
    expect(isPrivateHost("8.8.8.8")).toBe(false);
    expect(isPrivateHost("1.1.1.1")).toBe(false);
  });

  it("accepts public hostnames", () => {
    expect(isPrivateHost("example.com")).toBe(false);
    expect(isPrivateHost("sub.example.com")).toBe(false);
    expect(isPrivateHost("en.wikipedia.org")).toBe(false);
  });
});

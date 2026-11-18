// Tests for safe-fetch.js: links to private addresses must be refused (SSRF protection).
// No internet needed: every refused link is stopped before any request is sent.
const test = require("node:test");
const assert = require("node:assert");
const { safeFetch, isPrivateAddress, BlockedLinkError } = require("../safe-fetch.js");

test("private and local addresses are recognized", () => {
  for (const ip of [
    "127.0.0.1", "127.8.9.10", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.20",
    "169.254.169.254", "0.0.0.0", "100.64.0.1", "::1", "::", "fd00::1", "fe80::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1",
  ]) {
    assert.strictEqual(isPrivateAddress(ip), true, ip);
  }
});

test("public addresses are allowed", () => {
  for (const ip of ["8.8.8.8", "151.101.1.69", "172.32.0.1", "2606:4700::6810:84e5"]) {
    assert.strictEqual(isPrivateAddress(ip), false, ip);
  }
});

test("anything that isn't an address is refused", () => {
  assert.strictEqual(isPrivateAddress("not-an-ip"), true);
});

test("links to this computer or the cloud settings address are refused", async () => {
  for (const link of [
    "http://localhost:3000/api/recipes",
    "http://127.0.0.1/",
    "http://[::1]/",
    "http://169.254.169.254/latest/meta-data/",
    "http://0x7f000001/", // 127.0.0.1 written in hex
    "http://2130706433/", // 127.0.0.1 written as one number
  ]) {
    await assert.rejects(safeFetch(link), BlockedLinkError, link);
  }
});

test("non-web links are refused", async () => {
  await assert.rejects(safeFetch("file:///etc/passwd"), BlockedLinkError);
  await assert.rejects(safeFetch("ftp://example.com/x"), BlockedLinkError);
});

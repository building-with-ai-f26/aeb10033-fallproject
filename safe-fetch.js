// Fetch a page or photo from a link someone pasted, but never from a private address.
//
// Why: the server reads recipe links for you. Without this check, a link like
// http://localhost:3000/... or http://169.254.169.254/ (where cloud servers keep their settings)
// would make the server read its own private network and show the result back.
// This attack is called SSRF (server-side request forgery).
//
// How: before each request, look up the website's address and refuse private ones.
// Redirects are followed one at a time, so a public link can't bounce to a private address.

const dns = require("node:dns/promises");
const net = require("node:net");

// Two separate lists: in one shared list, Node counts every IPv4 address as matching ::ffff:0:0/96.
const PRIVATE_V4 = new net.BlockList();
const PRIVATE_V6 = new net.BlockList();
for (const [address, bits] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private networks
  ["100.64.0.0", 10], // shared by internet providers
  ["127.0.0.0", 8], // this computer (localhost)
  ["169.254.0.0", 16], // link-local, including cloud settings at 169.254.169.254
  ["172.16.0.0", 12], // private networks
  ["192.0.0.0", 24], // special use
  ["192.168.0.0", 16], // home networks
  ["198.18.0.0", 15], // testing
  ["224.0.0.0", 3], // multicast and reserved (224.0.0.0 and up)
]) PRIVATE_V4.addSubnet(address, bits, "ipv4");
for (const [address, bits] of [
  ["::", 128], // unspecified
  ["::1", 128], // this computer (localhost)
  ["::ffff:0:0", 96], // IPv4 addresses written as IPv6, like ::ffff:127.0.0.1
  ["fc00::", 7], // private networks
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
]) PRIVATE_V6.addSubnet(address, bits, "ipv6");

class BlockedLinkError extends Error {}

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) return PRIVATE_V4.check(ip, "ipv4");
  if (net.isIPv6(ip)) return PRIVATE_V6.check(ip, "ipv6");
  return true; // not an address at all: refuse
}

// Refuse if the host name (or any address it points to) is private.
async function checkHost(url) {
  const host = url.hostname.replace(/^\[|\]$/g, ""); // [::1] -> ::1
  const addresses = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
  if (!addresses.length || addresses.some(isPrivateAddress)) {
    throw new BlockedLinkError("That link points to a private address, so it can't be read.");
  }
}

const MAX_REDIRECTS = 5;

// Like fetch(), for http/https links only, refusing private addresses at every redirect.
async function safeFetch(link, options = {}) {
  let url = new URL(link);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new BlockedLinkError("Only http and https links can be read.");
    await checkHost(url);
    const res = await fetch(url, { ...options, redirect: "manual" });
    const next = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && next) {
      url = new URL(next, url);
      continue;
    }
    return res;
  }
  throw new BlockedLinkError("That link redirected too many times.");
}

module.exports = { safeFetch, isPrivateAddress, BlockedLinkError };

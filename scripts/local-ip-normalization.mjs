function parseIpv4(value) {
  const parts = String(value || "").trim().split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return NaN;
    return Number(part);
  });
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
  return octets;
}

function isPrivateIpv4(octets) {
  const [first, second] = octets;
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

function isBridgePreferredIpv4(octets) {
  const [first] = octets;
  return first === 10 || first === 192;
}

function compareIpv4(left, right) {
  const leftOctets = parseIpv4(left) ?? [];
  const rightOctets = parseIpv4(right) ?? [];
  for (let index = 0; index < 4; index += 1) {
    const diff = (leftOctets[index] ?? 0) - (rightOctets[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return left.localeCompare(right);
}

function normalizeIpv6(value) {
  const address = String(value || "").trim().toLowerCase().split("%")[0];
  return address.includes(":") ? address : "";
}

function isPublicIpv6(address) {
  if (!address || address === "::" || address === "::1") return false;
  if (address.startsWith("fe80:")) return false;
  if (address.startsWith("fc") || address.startsWith("fd")) return false;
  if (address.startsWith("ff")) return false;
  return true;
}

export function normalizeLocalIpsForDisplay(entries) {
  const privateIpv4 = [];
  const publicIpv6 = [];
  for (const entry of entries ?? []) {
    if (!entry || entry.internal) continue;
    const octets = parseIpv4(entry.address);
    if (!octets) {
      const ipv6 = normalizeIpv6(entry.address);
      if (isPublicIpv6(ipv6)) publicIpv6.push(ipv6);
      continue;
    }
    if (!isPrivateIpv4(octets)) continue;
    const hostOctet = octets[3];
    if (hostOctet === 0 || hostOctet === 255) continue;
    privateIpv4.push(octets.join("."));
  }

  const unique = Array.from(new Set(privateIpv4));
  const preferred = unique.filter((address) => isBridgePreferredIpv4(parseIpv4(address) ?? []));
  const ipv4 = (preferred.length ? preferred : unique).sort(compareIpv4);
  if (ipv4.length) return ipv4;
  return Array.from(new Set(publicIpv6)).sort().slice(0, 1);
}

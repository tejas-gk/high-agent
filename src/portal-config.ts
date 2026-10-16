export type PortalConfig = {
  name: string;
  approvedHosts: string[];
};

export function portalConfig(): PortalConfig {
  const approvedHosts = (process.env.PORTAL_ALLOWED_HOSTS || "test-tangerine.hipeely.com")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return {
    name: process.env.PORTAL_RETAILER_NAME?.trim() || "Tangerine",
    approvedHosts,
  };
}

export function isApprovedPortalUrl(rawUrl: string): boolean {
  try {
    return portalConfig().approvedHosts.includes(new URL(rawUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function isApprovedPortalHost(host: string): boolean {
  return portalConfig().approvedHosts.includes(host.toLowerCase());
}

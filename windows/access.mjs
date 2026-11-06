import { createRemoteJWKSet, jwtVerify } from 'jose';

export function validateConfig(config) {
  if (!config || !/^[a-z0-9.-]+$/.test(config.hostname || '') ||
      !/^[a-z0-9-]+$/.test(config.teamName || '') ||
      !/^[a-f0-9]{64}$/.test(config.audience || '') ||
      !/^[^\s@]+@[^\s@]+$/.test(config.allowedEmail || '') ||
      !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) {
    throw new Error('A hostname, Access team, audience, owner email and loopback port are required');
  }
  return config;
}

export function createAccessVerifier(config, keyResolver) {
  validateConfig(config);
  const issuer = `https://${config.teamName}.cloudflareaccess.com`;
  const keys = keyResolver || createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), {
    timeoutDuration: 5000,
  });
  return async request => {
    const token = request.headers['cf-access-jwt-assertion'];
    if (typeof token !== 'string' || token.length > 16384) throw new Error('Access required');
    const { payload } = await jwtVerify(token, keys, {
      issuer, audience: config.audience, algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'sub', 'email'],
    });
    if (typeof payload.email !== 'string' ||
        payload.email.toLowerCase() !== config.allowedEmail.toLowerCase() ||
        !Number.isSafeInteger(payload.exp)) throw new Error('Owner identity required');
    return { expiresAt: payload.exp * 1000 };
  };
}

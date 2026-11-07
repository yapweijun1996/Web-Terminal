export const GRANT_DURATIONS = Object.freeze(
  [
    { value: "3600", label: "1 hour" },
    { value: "86400", label: "1 day" },
    { value: "604800", label: "1 week (7 days)" },
    { value: "2592000", label: "1 month (30 days)" },
    { value: "7776000", label: "3 months (90 days)" },
    { value: "15552000", label: "6 months (180 days)" },
    { value: "31536000", label: "1 year (365 days)" },
  ].map(Object.freeze),
);
export const DEFAULT_GRANT_SECONDS = 2592000;
export const MAX_GRANT_SECONDS = 31536000;

export const AUTH_CODE_TTL_MS = 60000;
